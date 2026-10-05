# Souffleur

**Real-time meeting copilot for macOS.** Souffleur transcribes both sides of a call live, translates the other side into French, and suggests what to say next, using the context you give it. Its window stays on top of Meet or Zoom and is excluded from screen sharing and recordings.

The interface and prompts are in French. The other party can speak any language supported by Deepgram.

---

## Ce que ça fait

- **Transcription en direct des deux côtés** : l'audio du meeting (via BlackHole) et ton micro, sur deux flux séparés, donc chaque locuteur est identifié par sa source.
- **Traduction en français** de ce que dit l'interlocuteur.
- **Suggestions de réponse** courtes, prêtes à dire, nourries par tes contextes (offre, objections, notes du call).
- **Mémo** : ton script, visible pendant le call.
- **Fenêtre invisible au partage d'écran** (`setContentProtection`).
- Chaque session est sauvegardée en local (`.md` et `.json`).

## Usage responsable

Souffleur enregistre et transcrit une conversation. Selon le pays, **le consentement des participants peut être obligatoire** pour enregistrer ou transcrire un appel. Informe tes interlocuteurs et respecte le droit applicable. L'invisibilité au partage d'écran sert à garder tes notes pour toi, pas à tromper qui que ce soit.

## Où vont les données

| Donnée | Destination |
|---|---|
| Audio des deux flux | [Deepgram](https://deepgram.com) pour la transcription |
| Transcription et contextes | Anthropic (Claude), via la CLI Claude Code ou l'API |
| Sessions, contextes, réglages | en local, dans `~/souffleur/` |

Souffleur n'envoie rien d'autre et n'ajoute aucune télémétrie. En mode `cli`, la CLI Claude Code applique ses propres réglages.

## Prérequis

- macOS
- Node 22 ou plus
- `ffmpeg` : `brew install ffmpeg`
- [BlackHole 2ch](https://existential.audio/blackhole/) : `brew install blackhole-2ch`
- Une clé [Deepgram](https://console.deepgram.com)
- Pour le coach, au choix :
  - la CLI Claude Code connectée (`claude auth login`), le coach tourne alors sur ton abonnement (par défaut) ;
  - ou une clé API Anthropic avec `LLM_PROVIDER=api`.

## Installation

Ne clone pas le dépôt dans `~/souffleur` : c'est le dossier où l'app range tes données.

```bash
npm install
cp .env.example .env   # puis renseigne DEEPGRAM_API_KEY
npm start
```

Au premier lancement, macOS demande l'accès au micro pour Electron : accepte.

## Audio

Souffleur entend l'interlocuteur grâce à une copie de la sortie son envoyée vers BlackHole.

**Automatique** (crée un périphérique « Meeting » = ton casque + BlackHole, et le met en sortie) :

```bash
npm run audio:setup     # avant le call
npm run audio:restore   # après le call
npm run audio:status    # état actuel
```

`scripts/launch.sh` enchaîne les trois : réglage audio, lancement de l'app, restauration à la fermeture.

**À la main** : Configuration audio et MIDI → `+` → Créer un périphérique à sorties multiples → coche ton casque et BlackHole 2ch → nomme le « Meeting » → mets-le en sortie pendant le call.

Dans Souffleur : **Eux** = BlackHole 2ch, **Toi** = ton micro.

## Utilisation

1. Coche les contextes à charger, écris le contexte du call, colle ton script dans le mémo.
2. Démarrer.
3. Raccourcis : `⌘⇧C` masquer ou afficher · `⌘⇧R` relance vers l'objectif du call · `⌘⇧P` pause · `⌘⇧M` mémo.
4. Stop : la session est sauvée dans `~/souffleur/sessions/`.

## Contextes

`~/souffleur/contexts/*.md` : un fichier par contexte, première ligne `# Titre`. Le contenu est relu à chaque démarrage de session.

Les fichiers préfixés par `_` (par exemple `_persona.md`) sont toujours injectés.

Au premier lancement, les modèles de `contexts.seed/` sont copiés : `_persona.md` (ta voix et ta méthode), `objections.md`, `mon-offre.md`. Remplis-les.

## Réglages

Tous dans `.env` (voir `.env.example`) :

| Variable | Rôle | Défaut |
|---|---|---|
| `DEEPGRAM_API_KEY` | transcription | requis |
| `LLM_PROVIDER` | `cli` (abonnement Claude Code) ou `api` | `cli` |
| `ANTHROPIC_API_KEY` | requis si `LLM_PROVIDER=api` | |
| `STT_LANGUAGE` | `multi`, ou un code fixe (`en`, `fr`…), plus précis si la langue du call est connue | `multi` |
| `STT_ENDPOINTING` | ms de silence qui ferment un segment ; monte vers 800 si les phrases sont coupées | `300` |
| `STT_UTTERANCE_END` | ms de silence qui ferment un tour de parole | `1000` |
| `FFMPEG_PATH` | chemin de `ffmpeg` si l'app est lancée depuis le Finder | |

## Tester sans meeting

App lancée avec **Eux** = BlackHole 2ch :

```bash
npm run smoke
```

Une phrase anglaise est jouée dans BlackHole : transcription, traduction et suggestion doivent apparaître.

```bash
npm test
```

## Coût et latence

- Deepgram Nova 3 : environ 0,50 $ de l'heure pour les deux flux.
- Mode `cli` : inclus dans l'abonnement Claude, mais chaque phrase de l'interlocuteur consomme du quota (partagé avec Claude Code). Si le quota bloque en plein call : `LLM_PROVIDER=api` et une clé API.
- Latences mesurées : premier mot Deepgram ≈ 750 ms, traduction ≈ 540 ms, suggestion complète ≈ 2,5 à 3 s.

## Architecture

Voir [`docs/spec.md`](docs/spec.md).

## Licence

[MIT](LICENSE)
