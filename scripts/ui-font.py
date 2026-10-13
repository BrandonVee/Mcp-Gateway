"""Refresh or check the self-hosted Chinese UI font (requires fonttools[woff])."""

import argparse
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "packages/admin-web/src/assets/fonts/ResourceHanRoundedCN-UI.woff2"


def ui_characters():
    sources = list((ROOT / "packages/admin-web/src").rglob("*.ts"))
    sources += list((ROOT / "packages/admin-web/src").rglob("*.tsx"))
    sources.append(ROOT / "packages/auth-server/src/modules/oauth/pages.ts")
    return {
        ord(char)
        for source in sources
        for char in source.read_text(encoding="utf-8")
        if "\u3000" <= char <= "\u303f"
        or "\u3400" <= char <= "\u9fff"
        or "\uf900" <= char <= "\ufaff"
        or "\uff00" <= char <= "\uffef"
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="ResourceHanRoundedCN-VF.otf from v1.910")
    args = parser.parse_args()
    required = ui_characters()
    with TTFont(TARGET) as current:
        existing = set(current.getBestCmap())
    if args.source:
        with TTFont(args.source) as font:
            unsupported = required - set(font.getBestCmap())
            if unsupported:
                parser.error("Source font lacks UI characters: " + "".join(map(chr, sorted(unsupported))))
            options = subset.Options()
            options.flavor = "woff2"
            options.layout_features = ["*"]
            options.hinting = False
            subsetter = subset.Subsetter(options=options)
            # Keep the existing coverage, including punctuation and dynamic-name glyphs.
            subsetter.populate(unicodes=existing | required)
            subsetter.subset(font)
            font.flavor = "woff2"
            font.save(TARGET)
    with TTFont(TARGET) as font:
        missing = required - set(font.getBestCmap())
    if missing:
        parser.error("UI font lacks characters: " + "".join(map(chr, sorted(missing))))
    print(f"UI font covers all {len(required)} Chinese characters and punctuation used in the interface.")


if __name__ == "__main__":
    main()
