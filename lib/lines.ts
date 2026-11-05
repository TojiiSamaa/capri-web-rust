// The few lines Capri says without asking the model. French is how they were written, and the default with no language set.
// shortcut: every other language falls back to English, translate them here if one needs its own.
export const MAX_STEPS = 12;
export const TOO_MANY_STEPS = `J'arrête après ${MAX_STEPS} étapes, je tourne en rond. Dis-moi si je continue.`;

const ENGLISH: Record<string, string> = {
  [TOO_MANY_STEPS]: `Stopping after ${MAX_STEPS} steps, I'm going in circles. Tell me if I should keep going.`,
  "Ma ligne vient de griller. Réessaie dans un instant.": "My line just fried. Try again in a moment.",
  "Le fournisseur refuse ma clé. Regarde dans les paramètres.": "The provider is refusing my key. Check the settings.",
  "Je n'arrive pas à relire ma mémoire. Recharge la page, je ne sauvegarde rien d'ici là.": "I can't read my memory back. Reload the page, I'm not saving anything until then.",
  "Je n'ai pas encore de cerveau : choisis un modèle dans les paramètres.": "I don't have a brain yet: pick a model in the settings.",
  "Ce navigateur ne sait pas m'écouter. Essaie Chrome, Edge ou Safari.": "This browser can't listen to me. Try Chrome, Edge or Safari.",
  "Le micro est bloqué. Autorise-le pour cette page dans le navigateur.": "The mic is blocked. Allow it for this page in the browser.",
  "Je ne trouve aucun micro sur cette machine.": "I can't find a mic on this machine.",
  "Le service vocal du navigateur ne répond pas.": "The browser's voice service isn't answering.",
  "Toujours dessus.": "Still on it.",
  "Ça avance, encore un instant.": "Getting there, one more moment.",
  "Je n'ai pas oublié, ça mouline.": "I haven't forgotten, it's grinding away.",
  "J'arrête là. Ce qui était déjà en cours peut quand même aller au bout.": "Stopping here. Whatever was already running may still finish.",
  "Ma ligne a grillé en plein travail, je n'ai pas pu finir.": "My line fried mid-job, I couldn't finish.",
  "Oui ?": "Yes?",
};

const french = (language: string) => !language || language === "French";

// Exact matches only, so the model's own words pass through untouched.
export const fixedLine = (line: string, language: string) => (french(language) ? line : (ENGLISH[line] ?? line));

export const needsApproval = (tool: string, language: string) => (french(language) ? `J'ai besoin de ton accord pour ${tool}.` : `I need your OK for ${tool}.`);
export const toolFailed = (tool: string, language: string) => (french(language) ? `${tool} a échoué, je regarde.` : `${tool} failed, looking into it.`);
export const startingTool = (tool: string, language: string) => (french(language) ? `Je lance ${tool}.` : `Running ${tool}.`);

export function reminderLine(text: string, late: string | null, language: string) {
  if (french(language)) return `Rappel : ${text}${late ? ` (prévu ${late})` : ""}`;
  return `Reminder: ${text}${late ? ` (due ${late})` : ""}`;
}
