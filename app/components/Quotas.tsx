// The quota panel on the main screen.
"use client";

import { useEffect, useState } from "react";
import { type Gauge as GaugeData, type Live, type Reading, span } from "@/lib/quota";
import type { Settings } from "@/lib/settings";

const POLL = 60_000; // both endpoints are free to read
const LOCAL = /^https?:\/\/(localhost|127\.|\[::1\])/i;

// A number for people, with its unit when it has one.
const amount = (n: number, unit?: string) =>
  `${n.toLocaleString("fr-FR", unit ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : undefined)}${unit ? ` ${unit}` : ""}`;

// One meter: what's left or used, and when it resets.
function Gauge({ g, now }: { g: GaugeData; now: number }) {
  const over = g.resetAt !== undefined && g.resetAt <= now; // the number on screen belongs to a window that has ended
  const share = g.remaining !== undefined && g.limit ? Math.min(100, (g.remaining / g.limit) * 100) : null;
  return (
    <div className="gauge">
      <div className="gauge-line">
        <span>{g.label}</span>
        {!over && (
          <b>
            {g.remaining !== undefined ? amount(g.remaining, g.unit) : amount(g.used ?? 0, g.unit)}
            {g.limit !== undefined && <small> / {amount(g.limit, g.unit)}</small>}
          </b>
        )}
      </div>
      {share !== null && !over && (
        <div className="bar" role="meter" aria-label={`${g.label} restants`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share)}>
          <i className={share < 10 ? "low" : ""} style={{ width: `${share}%` }} />
        </div>
      )}
      {over ? <small>Fenêtre réinitialisée, relue au prochain message.</small> : g.resetAt !== undefined && <small>Réinitialisé dans {span(g.resetAt - now)}</small>}
    </div>
  );
}

// Polls the endpoints that exist, and shows what chat replies reported for the rest. Never an estimate.
export default function Quotas({ settings: s, live }: { settings: Settings; live: Live }) {
  const [open, setOpen] = useState(() => matchMedia("(min-width: 641px)").matches);
  const [now, setNow] = useState(() => Date.now());
  const [polled, setPolled] = useState<{ credits?: Reading; voice?: Reading; at: number }>({ at: 0 });
  const cloudVoice = s.voiceMode === "cloud" && s.elevenKeySet;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // A finished reply can have used credits, so it reads them again too.
  useEffect(() => {
    const stop = new AbortController();
    const read = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/quota", { method: "POST", signal: stop.signal });
        if (res.ok) setPolled({ ...(await res.json()), at: Date.now() });
      } catch (error) {
        if (!stop.signal.aborted) console.error("[quota]", error);
      }
    };
    read();
    const id = setInterval(read, POLL);
    return () => {
      stop.abort();
      clearInterval(id);
    };
  }, [s.baseUrl, s.apiKeySet, s.model, cloudVoice, live.tokens]);

  const gauges = [...(polled.credits?.gauges ?? []), ...(live.gauges ?? [])];
  const local = LOCAL.test(s.baseUrl);

  return (
    <details className="quotas" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <h2>Quotas</h2>
      </summary>
      <div className="quota-group">
        <p className="quota-name">{s.provider}</p>
        {gauges.map((g) => (
          <Gauge key={g.label} g={g} now={now} />
        ))}
        {polled.credits?.error !== undefined && (
          <p className="quota-note warn">{polled.credits.error === 401 || polled.credits.error === 403 ? "Clé refusée, crédits illisibles." : "Crédits illisibles pour l'instant."}</p>
        )}
        {!gauges.length && polled.credits?.error === undefined && (
          <p className="quota-note">
            {!live.gauges ? "Le relevé arrive avec le prochain message." : local ? "Serveur local : aucun quota envoyé." : `${s.provider} n'envoie aucun quota avec ses réponses.`}
          </p>
        )}
        {live.limited && (
          <p className="quota-note warn" role="status">
            Limite atteinte{live.limited.until && live.limited.until > now ? `, réessaie dans ${span(live.limited.until - now)}` : " (erreur 429)"}.
          </p>
        )}
        {live.gauges?.length ? <p className="quota-note">Relevé il y a {span(now - live.at)}</p> : null}
        {live.tokens > 0 && <p className="quota-note">{live.tokens.toLocaleString("fr-FR")} tokens utilisés dans cet onglet</p>}
      </div>
      {cloudVoice && (
        <div className="quota-group">
          <p className="quota-name">ElevenLabs</p>
          {polled.voice?.gauges?.map((g) => (
            <Gauge key={g.label} g={g} now={now} />
          ))}
          {polled.voice?.gauges?.length === 0 && <p className="quota-note">ElevenLabs n'a envoyé aucun quota.</p>}
          {polled.voice?.error !== undefined && (
            <p className="quota-note warn">{polled.voice.error === 401 || polled.voice.error === 403 ? "Cette clé n'a pas accès à l'abonnement." : "Abonnement illisible pour l'instant."}</p>
          )}
        </div>
      )}
    </details>
  );
}
