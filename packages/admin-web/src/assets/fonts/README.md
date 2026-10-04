# UI font

`ResourceHanRoundedCN-UI.woff2` is a WOFF2 subset of Resource Han Rounded CN v1.910's variable font. It contains the Chinese characters and punctuation currently used in the admin UI and OAuth pages; names and other dynamic text fall back to system Chinese fonts when a glyph is absent. The font's SIL OFL 1.1 license is included in `OFL-License.txt`.

`Nunito-UI.woff2` is a Latin WOFF2 subset of the [Nunito variable font](https://github.com/google/fonts/tree/main/ofl/nunito). Its SIL OFL 1.1 license is included in `Nunito-OFL.txt`.

Source: https://github.com/CyanoHao/Resource-Han-Rounded/releases/tag/v1.910

Refresh the subset whenever interface copy changes. Missing glyphs otherwise fall back to a system font within the same sentence and can appear to have different weights.

Download and extract `ResourceHanRoundedCN-VF.otf` from the CN asset of the source release above, then run from the repository root:

```sh
uv run --with 'fonttools[woff]' python scripts/ui-font.py --source /path/to/ResourceHanRoundedCN-VF.otf
```

The script collects Chinese characters and punctuation from admin UI sources and OAuth pages while retaining existing glyphs. Check coverage without regenerating the font:

```sh
uv run --with 'fonttools[woff]' python scripts/ui-font.py
```

CI checks the bundled font's actual character map against current UI sources so newly added copy cannot silently introduce missing Chinese glyphs.

Latin letters and numbers intentionally use Nunito. Dynamic service names containing characters outside the subset still fall back to system fonts.
