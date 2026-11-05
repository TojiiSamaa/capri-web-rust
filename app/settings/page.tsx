// The settings page: brain, identity, keys, voice, behaviour and MCP.
"use client";

import Link from "next/link";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { LANGUAGES } from "@/lib/languages";
import { INFOS_SERVER, TOKEN_KINDS, USE_CASES } from "@/lib/mcpConfig";
import { BASE } from "@/lib/persona";
import {
  chatBody, DEFAULTS, LAYER_DEFAULTS, keyFrom, keyLabel, loadStore, OPTIONS, PROVIDERS, saved, clearHistory, saveSecrets, saveSettings, type Settings, SPEECH_MODELS,
} from "@/lib/settings";
import { speak } from "@/lib/voice";

type Change = <K extends keyof Settings>(key: K, value: Settings[K]) => void;

// A titled block of settings.
function Section({ title, tools, children }: { title: string; tools?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h2>
        <span>{title}</span>
        {tools}
      </h2>
      {children}
    </section>
  );
}

// One setting: its label, optional hint and control.
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="row">
      <span className="name">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}

// An on/off setting.
function Toggle({ label, hint, on, set }: { label: string; hint?: string; on: boolean; set: (on: boolean) => void }) {
  return (
    <div className="row">
      <span className="name">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <span className="switch" role="group" aria-label={label}>
        <button type="button" aria-pressed={!on} className={on ? "" : "off"} onClick={() => set(false)}>OFF</button>
        <button type="button" aria-pressed={on} className={on ? "on" : ""} onClick={() => set(true)}>ON</button>
      </span>
    </div>
  );
}

// The Mainframe's stepper: arrows, the current name, a line of ticks.
function Stepper({ label, hint, names, at, set }: { label: string; hint?: string; names: string[]; at: number; set: (at: number) => void }) {
  return (
    <div className="row">
      <span className="name">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <span className="stepper" role="group" aria-label={label}>
        <button type="button" aria-label={`${label} : moins`} disabled={at <= 0} onClick={() => set(at - 1)}>◀</button>
        <output>
          {names[at]}
          <i style={{ width: `${(at / Math.max(1, names.length - 1)) * 100}%` }} />
        </output>
        <button type="button" aria-label={`${label} : plus`} disabled={at >= names.length - 1} onClick={() => set(at + 1)}>▶</button>
      </span>
    </div>
  );
}

type McpServer = { name: string; url?: string; useCase?: string; connected: boolean; error?: string; tools: { name: string; tool: string }[] };
type McpStatus = { error?: string; servers: McpServer[] };

// The MCP tab: add and remove servers, and choose which tools run without asking.
function McpTab({ s, set }: { s: Settings; set: Change }) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [problem, setProblem] = useState("");
  const [working, setWorking] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [useCase, setUseCase] = useState("");
  const [preset, setPreset] = useState("");
  const [token, setToken] = useState("");
  const [tokenKind, setTokenKind] = useState(TOKEN_KINDS[0].id);

  // Connecting can take a while: a server that doesn't answer gets 20 seconds.
  const call = async (doing: string, path: string, init?: RequestInit) => {
    setProblem("");
    setWorking(doing);
    try {
      const res = await fetch(path, init);
      const data = await res.json();
      if (!res.ok) {
        setProblem(data.problem ?? "Impossible de joindre le serveur de Capri.");
        return false;
      }
      setStatus(data);
      return true;
    } catch {
      setProblem("Impossible de joindre le serveur de Capri.");
      return false;
    } finally {
      setWorking("");
    }
  };
  const send = (method: string, body: unknown) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  useEffect(() => {
    call("Connexion aux serveurs…", "/api/mcp");
  }, []);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (await call(`Connexion à ${name.trim()}…`, "/api/mcp", send("PUT", { name, url, useCase, token, tokenKind }))) {
      setName("");
      setUrl("");
      setUseCase("");
      setPreset("");
      setToken("");
    }
  };

  const pick = (chosen: string) => {
    setPreset(chosen);
    const text = USE_CASES.find((c) => c.name === chosen)?.text;
    if (!text) return;
    setUseCase(text);
    if (!name.trim()) setName(chosen);
  };

  return (
    <div className="columns">
      <div>
        <Section title="AJOUTER UN MCP">
          <form onSubmit={add}>
            <Row label="Cas d'usage" hint="Préremplit la description">
              <select value={preset} onChange={(e) => pick(e.target.value)}>
                <option value="">Personnalisé</option>
                {USE_CASES.map((c) => <option key={c.name}>{c.name}</option>)}
              </select>
            </Row>
            <Row label="Nom">
              <input required maxLength={40} value={name} placeholder="Ma boîte mail" onChange={(e) => setName(e.target.value)} />
            </Row>
            <Row label="URL" hint="Transport Streamable HTTP">
              <input required type="url" value={url} placeholder="https://exemple.com/mcp" onChange={(e) => setUrl(e.target.value)} />
            </Row>
            <Row label="Token (optionnel)" hint="Enregistré en clair dans mcp.json, sur cette machine">
              <input type="password" autoComplete="off" value={token} placeholder="Si le serveur en demande un" onChange={(e) => setToken(e.target.value)} />
            </Row>
            {token && (
              <Row label="Envoyé dans" hint="Regarde la doc du serveur">
                <select value={tokenKind} onChange={(e) => setTokenKind(e.target.value)}>
                  {TOKEN_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                </select>
              </Row>
            )}
            <label className="block">
              <span className="name">Description du cas d'usage <small>Capri s'en sert pour choisir le bon outil</small></span>
              <textarea required rows={3} maxLength={500} value={useCase} placeholder="À quoi sert ce serveur, et quand Capri doit-elle l'utiliser ?" onChange={(e) => setUseCase(e.target.value)} />
            </label>
            <div className="keys">
              <button type="submit" className="key cyan" disabled={!!working}>Ajouter</button>
            </div>
          </form>
          {problem && <p className="note warn" role="alert">{problem}</p>}
        </Section>

        <Section title="COMPORTEMENT">
          <Toggle label="Utiliser les outils MCP" on={s.mcpEnabled} set={(v) => set("mcpEnabled", v)} />
          <Toggle label="Demander avant chaque outil" hint="Un outil peut agir sur ta machine ou tes comptes" on={s.mcpConfirm} set={(v) => set("mcpConfirm", v)} />
          <Toggle label="Annoncer les étapes à voix haute" hint="Sinon dans la bulle seulement" on={s.mcpVoiceNews} set={(v) => set("mcpVoiceNews", v)} />
        </Section>
      </div>

      <div>
        <Section title="MES MCP" tools={<button type="button" className="key" disabled={!!working} onClick={() => call("Reconnexion…", "/api/mcp?reload")}>Recharger</button>}>
          {working && <p className="note" role="status">{working}</p>}
          {status?.error && <p className="note warn" role="alert">{status.error}</p>}
          {status && !status.error && !status.servers.length && !working && <p className="note">Aucun MCP pour l'instant.</p>}
          <ul className="servers">
            {status?.servers.map((server) => (
              <li key={server.name}>
                <div className="server-head">
                  <span>
                    <b>{server.name}</b> <span className={server.connected ? "ok" : "warn"}>{server.connected ? `${server.tools.length} outil${server.tools.length > 1 ? "s" : ""}` : "non connecté"}</span>
                  </span>
                  {server.url && (
                    <button type="button" className="key" disabled={!!working} aria-label={`Retirer ${server.name}`} onClick={() => call(`Retrait de ${server.name}…`, "/api/mcp", send("DELETE", { name: server.name }))}>Retirer</button>
                  )}
                </div>
                <small>{server.url ?? (server.name === INFOS_SERVER ? "Intégré à Capri" : "Serveur local (mcp.json)")}</small>
                {server.useCase && <small className="use-case">{server.useCase}</small>}
                {server.error && <small className="warn">{server.error}{server.url ? " Vérifie l'URL et le token." : ""}</small>}
                {server.connected && <small>{server.tools.map((t) => t.tool).join(", ")}</small>}
              </li>
            ))}
          </ul>
        </Section>

        {s.mcpConfirm && s.mcpAllowed.length > 0 && (
          <Section title="TOUJOURS AUTORISÉS">
            <ul className="servers">
              {s.mcpAllowed.map((allowed) => (
                <li key={allowed} className="allowed">
                  <span>{allowed}</span>
                  <button type="button" className="key" onClick={() => set("mcpAllowed", s.mcpAllowed.filter((n) => n !== allowed))}>Retirer</button>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </div>
  );
}

// Records the next key combination pressed. Escape cancels.
function KeyPicker({ label, value, set }: { label: string; value: string; set: (key: string) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") return setListening(false);
      const key = keyFrom(e);
      if (!key) return;
      set(key);
      setListening(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [listening, set]);
  return (
    <div className="row">
      <span className="name">{label}</span>
      <button type="button" className={`key ${listening ? "cyan" : ""}`} onClick={() => setListening(!listening)}>
        {listening ? "Appuie sur les touches (Échap annule)" : keyLabel(value)}
      </button>
    </div>
  );
}

// Hint for effects that need real audio, which the browser's voice doesn't give.
const AUDIO_ONLY = (s: Settings) => (s.voiceMode === "browser" ? "Sans effet sur la voix du navigateur" : undefined);

// A key goes straight to the server and never comes back: the field only says whether one is saved.
function SecretRow({ label, hint, isSet, placeholder, save }: { label: string; hint?: string; isSet: boolean; placeholder?: string; save: (value: string) => void }) {
  const [typed, setTyped] = useState("");
  return (
    <Row label={label} hint={hint}>
      <div className="secret">
        <input
          type="password"
          autoComplete="off"
          value={typed}
          placeholder={isSet ? "Enregistrée, masquée" : placeholder}
          aria-label={label}
          onChange={(e) => {
            setTyped(e.target.value);
            save(e.target.value);
          }}
        />
        {isSet && !typed && <button type="button" className="key" onClick={() => save("")}>Effacer</button>}
      </div>
    </Row>
  );
}

// Every change saves as it's made, through /api/store.
export default function SettingsPage() {
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [ready, setReady] = useState(false);
  const [storeDown, setStoreDown] = useState(false);
  const [resets, setResets] = useState(0);
  const [models, setModels] = useState<string[]>([]);
  const [brainNote, setBrainNote] = useState("");
  const [voiceNote, setVoiceNote] = useState("");
  const [memories, setMemories] = useState(0);
  const [tab, setTab] = useState<"general" | "mcp">("general");

  useEffect(() => {
    let gone = false;
    loadStore()
      .then(({ settings, historyCount }) => {
        if (gone) return;
        setS(settings);
        setMemories(historyCount);
        setReady(true);
      })
      .catch((error) => {
        console.error("[store]", error);
        if (!gone) setStoreDown(true);
      });
    return () => {
      gone = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    saveSettings(s);
  }, [s, ready]);

  useEffect(() => {
    document.documentElement.dataset.look = String(s.look);
  }, [s.look]);

  const set: Change = (key, value) => setS((old) => ({ ...old, [key]: value }));
  const provider = PROVIDERS.find((p) => p.name === s.provider);

  // Saves first, so the model list comes from the provider and key on screen.
  const refresh = async () => {
    setBrainNote("Je cherche ses modèles…");
    try {
      await saved();
      const res = await fetch("/api/models", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.status === 401 || data.status === 403 ? "Clé refusée par le fournisseur." : "Fournisseur injoignable. Vérifie l'adresse.");
      setModels(data.models);
      setBrainNote(`${data.models.length} modèles trouvés.`);
    } catch (error) {
      setBrainNote(error instanceof Error ? error.message : "Échec.");
    }
  };

  const testBrain = async () => {
    setBrainNote("J'essaie…");
    try {
      await saved();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Say hi in five words." }], ...chatBody(s) }),
      });
      const data = await res.json();
      if (res.ok) setBrainNote(`Connectée : « ${data.reply} »`);
      else if (data.error === "not_configured") setBrainNote("Choisis d'abord un modèle.");
      else setBrainNote(data.status === 401 || data.status === 403 ? "Clé refusée par le fournisseur." : `Échec${data.status ? ` (${data.status})` : ""}. Vérifie l'adresse et le modèle.`);
    } catch {
      setBrainNote("Échec. Le serveur ne répond pas.");
    }
  };

  const testVoice = async () => {
    setVoiceNote("");
    if (s.voiceMode === "off") return setVoiceNote("Sa voix est coupée.");
    if (s.voiceMode === "cloud" && (!s.elevenKeySet || !s.voiceId)) return setVoiceNote("Il faut une clé ElevenLabs et un ID de voix.");
    try {
      await saved();
      await speak("How do I sound now, choom?", s);
    } catch {
      setVoiceNote("ElevenLabs refuse. Vérifie la clé et l'ID de voix.");
    }
  };

  return (
    <main className="mainframe">
      <header>
        <h1>MAINFRAME</h1>
        <Link className="key cyan" href="/">Retour</Link>
        <button type="button" className="key" onClick={() => {
          if (confirm("Remettre tous les réglages par défaut ? Ta clé et ta personnalité seront effacées.")) {
            setS(DEFAULTS);
            saveSecrets({ apiKey: "", elevenKey: "" });
            setResets((n) => n + 1);
          }
        }}>Réinitialiser</button>
      </header>

      {storeDown && <p className="note warn" role="alert">Impossible de relire les réglages sur cette machine. Rien ne sera enregistré : recharge la page.</p>}

      <nav className="tabs" aria-label="Sections des paramètres">
        <button type="button" aria-current={tab === "general" ? "page" : undefined} onClick={() => setTab("general")}>Général</button>
        <button type="button" aria-current={tab === "mcp" ? "page" : undefined} onClick={() => setTab("mcp")}>MCP</button>
      </nav>

      {tab === "mcp" && <McpTab s={s} set={set} />}

      <div className="columns" hidden={tab !== "general"}>
        <div>
          <Section title="BRAIN">
            <Row label="Fournisseur">
              <select value={s.provider} onChange={(e) => {
                const next = PROVIDERS.find((p) => p.name === e.target.value)!;
                setS((old) => ({ ...old, provider: next.name, baseUrl: next.url || old.baseUrl }));
                setModels([]);
              }}>
                {PROVIDERS.map((p) => <option key={p.name}>{p.name}</option>)}
              </select>
            </Row>
            <Row label="Adresse du serveur">
              <input value={s.baseUrl} placeholder="http://127.0.0.1:1234/v1" onChange={(e) => set("baseUrl", e.target.value)} />
            </Row>
            <SecretRow key={`brain${resets}`} label="Clé API" hint="Gardée sur cette machine" isSet={s.apiKeySet} placeholder="Colle ta clé" save={(value) => {
              saveSecrets({ apiKey: value });
              set("apiKeySet", !!value.trim());
            }} />
            {provider?.keys && <p className="note"><a href={provider.keys} target="_blank" rel="noreferrer">Obtenir une clé {provider.name}</a></p>}
            <Row label="Modèle">
              <input list="models" value={s.model} placeholder="Nom du modèle" onChange={(e) => set("model", e.target.value)} />
              <datalist id="models">{models.map((m) => <option key={m} value={m} />)}</datalist>
            </Row>
            <div className="keys">
              <button type="button" className="key" onClick={refresh}>Actualiser les modèles</button>
              <button type="button" className="key cyan" onClick={testBrain}>Tester</button>
            </div>
            {brainNote && <p className="note" role="status">{brainNote}</p>}
            <Stepper label="Réponses" names={OPTIONS.lengths} at={s.replies} set={(v) => set("replies", v)} />
            <Stepper label="Mémoire" hint="Ce qu'elle garde de la discussion" names={OPTIONS.lengths} at={s.memory} set={(v) => set("memory", v)} />
            <Stepper label="Réponse max" names={OPTIONS.maxReply} at={s.maxReply} set={(v) => set("maxReply", v)} />
            <Stepper label="Bulle" hint="Durée d'affichage" names={OPTIONS.bubble} at={s.bubble} set={(v) => set("bubble", v)} />
            <Toggle label="Messages de suivi" hint="Une 2e pensée après sa réponse, consomme de l'API" on={s.followUps} set={(v) => set("followUps", v)} />
          </Section>

          <Section title="YOU">
            <Row label="Langue">
              <select value={s.language} onChange={(e) => set("language", e.target.value)}>
                <option value="">Auto (la tienne)</option>
                {LANGUAGES.map((l) => <option key={l[1]} value={l[1]}>{l[0]}</option>)}
              </select>
            </Row>
            <Row label="Comment doit-elle t'appeler ?">
              <input maxLength={60} value={s.nickname} placeholder="Ton nom ou un surnom" onChange={(e) => set("nickname", e.target.value)} />
            </Row>
            <label className="block">
              <span className="name">Ses notes sur toi</span>
              <textarea rows={4} maxLength={8000} value={s.notes} placeholder="Pronoms, passions, ce qu'elle doit savoir de toi" onChange={(e) => set("notes", e.target.value)} />
            </label>
            <label className="block">
              <span className="name">Sa personnalité <small>Ses règles de sécurité s'ajoutent toujours après</small></span>
              <textarea rows={8} maxLength={20000} value={s.personality || BASE} onChange={(e) => set("personality", e.target.value === BASE ? "" : e.target.value)} />
            </label>
            <div className="keys">
              <button type="button" className="key" onClick={() => set("personality", "")}>Remettre sa personnalité par défaut</button>
            </div>
          </Section>

          <Section title="KEYS">
            <p className="note">Ses raccourcis marchent quand l'onglet de Capri est au premier plan.</p>
            <KeyPicker label="Parler" value={s.keyTalk} set={(k) => set("keyTalk", k)} />
            <KeyPicker label="Écrire" value={s.keyType} set={(k) => set("keyType", k)} />
            <KeyPicker label="Cacher / montrer" value={s.keyHide} set={(k) => set("keyHide", k)} />
            <KeyPicker label="Discrète" value={s.keyQuiet} set={(k) => set("keyQuiet", k)} />
          </Section>
        </div>

        <div>
          <Section title="VOICE" tools={<button type="button" className="key" onClick={testVoice}>Tester sa voix</button>}>
            <div className="rungs" role="radiogroup" aria-label="Sa voix">
              {([["off", "OFF", "Silencieuse, texte seul"], ["browser", "VOIX DU NAVIGATEUR", "Gratuite"], ["cloud", "CLOUD VOICE", "ElevenLabs, clé requise"]] as const).map(([id, name, hint]) => (
                <button key={id} type="button" role="radio" aria-checked={s.voiceMode === id} className={s.voiceMode === id ? "lit" : ""} onClick={() => set("voiceMode", id)}>
                  <b>{name}</b> <small>{hint}</small>
                </button>
              ))}
            </div>
            {s.voiceMode === "cloud" && (
              <>
                <SecretRow key={`voice${resets}`} label="Clé ElevenLabs" isSet={s.elevenKeySet} save={(value) => {
                  saveSecrets({ elevenKey: value });
                  set("elevenKeySet", !!value.trim());
                }} />
                <Row label="ID de voix">
                  <input value={s.voiceId} onChange={(e) => set("voiceId", e.target.value.trim())} />
                </Row>
                <Row label="Modèle de voix">
                  <select value={s.speechModel} onChange={(e) => set("speechModel", e.target.value)}>
                    {SPEECH_MODELS.map((m) => <option key={m}>{m}</option>)}
                  </select>
                </Row>
              </>
            )}
            {voiceNote && <p className="note" role="status">{voiceNote}</p>}
            <Stepper label="Volume" names={OPTIONS.volume} at={s.volume} set={(v) => set("volume", v)} />
            <Stepper label="Hauteur" names={OPTIONS.pitch} at={s.pitch} set={(v) => set("pitch", v)} />
            <Stepper label="Vitesse" names={OPTIONS.speed} at={s.speed} set={(v) => set("speed", v)} />
            <Stepper label="Robot" hint={AUDIO_ONLY(s)} names={OPTIONS.amount} at={s.robot} set={(v) => set("robot", v)} />
            <Stepper label="Glitch" hint={AUDIO_ONLY(s)} names={OPTIONS.amount} at={s.glitch} set={(v) => set("glitch", v)} />
            <Toggle label="Couches de voix" hint={AUDIO_ONLY(s) ?? "Deux copies d'elle, mixées sous sa voix"} on={s.layers} set={(v) => set("layers", v)} />
            {s.layers && (
              <>
                <Stepper label="Couche 1 : hauteur" names={OPTIONS.layerPitch} at={s.layer1Pitch} set={(v) => set("layer1Pitch", v)} />
                <Stepper label="Couche 1 : retard" names={OPTIONS.layerDelay} at={s.layer1Delay} set={(v) => set("layer1Delay", v)} />
                <Stepper label="Couche 2 : hauteur" names={OPTIONS.layerPitch} at={s.layer2Pitch} set={(v) => set("layer2Pitch", v)} />
                <Stepper label="Couche 2 : retard" names={OPTIONS.layerDelay} at={s.layer2Delay} set={(v) => set("layer2Delay", v)} />
                <div className="keys">
                  <button type="button" className="key" onClick={() => setS((old) => ({ ...old, ...LAYER_DEFAULTS }))}>Couches par défaut</button>
                </div>
              </>
            )}
            <Toggle label="Son de frappe" hint="Quand elle écrit" on={s.typingSound} set={(v) => set("typingSound", v)} />
            <Toggle label="Hey Capri" hint="Micro ouvert tant que la page est ouverte. Le son part au service vocal du navigateur" on={s.wakeWord} set={(v) => set("wakeWord", v)} />
          </Section>

          <Section title="CAPRI">
            <Stepper label="Taille" names={OPTIONS.size} at={s.size} set={(v) => set("size", v)} />
            <Toggle label="Prendre de mes nouvelles" hint="Consomme un peu de ton API" on={s.checkIns} set={(v) => set("checkIns", v)} />
            <Stepper label="Couleurs du Mainframe" names={OPTIONS.look} at={s.look} set={(v) => set("look", v)} />
            <Toggle label="Caresses" hint="Frotte le curseur sur elle" on={s.headPats} set={(v) => set("headPats", v)} />
          </Section>

          <Section title="MOVES">
            <Stepper label="Balade" names={OPTIONS.wander} at={s.wander} set={(v) => set("wander", v)} />
            <Stepper label="Sommeil" names={OPTIONS.sleep} at={s.sleep} set={(v) => set("sleep", v)} />
            <Stepper label="Apparitions" hint="Rythme de ses messages spontanés" names={OPTIONS.popIns} at={s.popIns} set={(v) => set("popIns", v)} />
            <Toggle label="Glitch au démarrage" on={s.intro} set={(v) => set("intro", v)} />
          </Section>

          <Section title="HABITS">
            <Toggle label="Se souvenir de nos discussions" hint="Tout reste sur cette machine. Désactivé, rien de nouveau n'est gardé" on={s.remember} set={(v) => set("remember", v)} />
            <div className="row">
              <span className="name">Messages en mémoire : {memories}</span>
              <button type="button" className="key" disabled={!memories} onClick={() => {
                if (!confirm(`Effacer définitivement ${memories} messages ?`)) return;
                clearHistory();
                setMemories(0);
              }}>Effacer</button>
            </div>
          </Section>
        </div>
      </div>
      <footer className="credit">
        Projet par <a href="https://ncombes.fr">Nathan C.</a>, non commercial. Réglages repris de <a href="https://github.com/lachydotmcg/capri-desktop">Capri</a> de Lachy.
      </footer>
    </main>
  );
}
