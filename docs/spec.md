# Souffleur : design

Copilote de meeting temps réel. Electron + Node. Invisible au partage d'écran (`setContentProtection`).

## Pipeline

```
BlackHole 2ch ─ffmpeg─▶ PCM ─▶ Deepgram WS (them) ─┐
micro        ─ffmpeg─▶ PCM ─▶ Deepgram WS (me)   ─┼─▶ Transcript reducer ─▶ utterance(them)
                                                   │                          ├─▶ Haiku 4.5 : traduction FR (stream)
                                                   │                          └─▶ Sonnet 5 effort=low : coach (stream, abort previous)
                                                   └─▶ SessionLog (json + md)
```

- 2 flux séparés → locuteur garanti par la source, pas de diarisation.
- Nova-3, par défaut `language=multi`, `endpointing=300`, `utterance_end_ms=1000`, réglables par `STT_LANGUAGE`, `STT_ENDPOINTING`, `STT_UTTERANCE_END`.
- Coach : system = instructions + `_persona.md` + contextes cochés + notes du call, un bloc `cache_control`. Messages = transcript en fenêtre glissante (60 tours, tronquée par blocs de 20 pour garder le cache), `cache_control` sur le dernier tour, puis instruction.
- Réponse finale 600 ms après la fin du tour de l'interlocuteur (annulée s'il reprend), minimum 3 mots. Aperçu pendant qu'il parle encore : 900 ms après chaque segment, minimum 6 mots. Nouvelle utterance pendant un stream coach → abort, seule la dernière suggestion compte.
- Sortie coach : `## Réponds` / `## Ce qu'il veut dire` / `## Attention` (optionnel).
- Deux fournisseurs pour le coach : `cli` (processus `claude` persistants, abonnement Claude Code, par défaut) ou `api` (SDK Anthropic, `ANTHROPIC_API_KEY`). Voir `llm/coach-cli.js`, `llm/cli-session.js`, `config.js`.

## Modules (`src/main`)

| Module | Rôle | Interface |
|---|---|---|
| `audio/devices.js` | liste devices avfoundation | `listAudioDevices() → [{index,name}]` |
| `audio/capture.js` | ffmpeg → PCM | `Capture.start()` → `data`, `level`, `exit` |
| `stt/deepgram.js` | WS streaming + reconnect | `result`, `utterance_end`, `status`, `error` |
| `stt/transcript.js` | reducer pur | `interim`, `segment`, `utterance` |
| `llm/prompts.js` | prompts + fenêtre | `buildCoachSystem`, `buildCoachMessages` |
| `llm/coach.js` | traduction + coach streams | `translate(turn, cb)`, `suggest(turns, cb)`, `abort()` |
| `context/store.js` | `~/souffleur/contexts` | `listContexts`, `readContexts`, `readPersona` |
| `session/log.js` | persistance | `addTurn`, `setTranslation`, `addSuggestion`, `save` |
| `session/session.js` | orchestrateur | `start`, `stop`, `coachNow`, `togglePause` |

## Erreurs

ffmpeg absent/device KO → bannière + statut rouge. WS Deepgram coupé → backoff 1→30 s, audio perdu pendant la coupure. Claude 429/5xx/refusal → message dans le panneau coach, prochaine utterance réessaie. Watchdog : « toi » parle mais « eux » silencieux 20 s → alerte routage BlackHole.

## Hors scope V1

Push wiki, résumé post-call (un outil de notes de réunion s'en charge), ScreenCaptureKit (remplacerait BlackHole), diarisation.
