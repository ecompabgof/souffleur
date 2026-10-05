#!/bin/bash
# Double-click launcher: route audio to "Meeting", start Souffleur, restore audio when it quits.
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
echo "→ Audio : sortie système = Meeting (écouteurs + BlackHole)"
swift scripts/audio-setup.swift create || echo "⚠ Audio non configuré — Souffleur n'entendra pas le meeting"
echo "→ Lancement Souffleur (ferme l'app avec ✕ pour remettre l'audio normal)"
npm start
echo "→ Audio : retour à la sortie normale"
swift scripts/audio-setup.swift restore
