# UI font

`ResourceHanRoundedCN-UI.woff2` is a WOFF2 subset of Resource Han Rounded CN v1.910's variable font. It contains the Chinese characters and punctuation currently used in the admin UI and OAuth pages; names and other dynamic text fall back to system Chinese fonts when a glyph is absent. The font's SIL OFL 1.1 license is included in `OFL-License.txt`.

`Nunito-UI.woff2` is a Latin WOFF2 subset of the [Nunito variable font](https://github.com/google/fonts/tree/main/ofl/nunito). Its SIL OFL 1.1 license is included in `Nunito-OFL.txt`.

Source: https://github.com/CyanoHao/Resource-Han-Rounded/releases/tag/v1.910

To refresh the subset after changing interface copy, collect Chinese characters from the UI sources and run `pyftsubset ResourceHanRoundedCN-VF.otf --text-file=UI_CHARS --flavor=woff2 --output-file=ResourceHanRoundedCN-UI.woff2 --layout-features='*' --no-hinting`.
