"""Check exact duplicate entries in the built-in JSON catalog."""
import collections
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent.parent
catalog = json.loads((root / 'seed/decks.json').read_text(encoding='utf-8'))
failed = False
for deck in catalog:
    counts = collections.Counter((w['term'].casefold(), w['meaning']) for w in deck['words'])
    duplicates = [term for (term, meaning), count in counts.items() if count > 1]
    failed = failed or bool(duplicates)
    print(deck['title'], len(deck['words']), 'dupes:', duplicates)
sys.exit(1 if failed else 0)
