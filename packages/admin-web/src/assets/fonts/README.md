# Legacy rounded font assets

The UI uses native system sans-serif fonts for both static copy and dynamic user content. Code and addresses use native monospace fonts. The font stacks are defined in `src/styles.css`; neither stack needs an external font request.

The previous bundled assets and their licenses remain here for historical reference. They are not imported by the application:

- `ResourceHanRoundedCN-UI.woff2`: Chinese subset of Resource Han Rounded CN v1.910, licensed under SIL OFL 1.1 (`OFL-License.txt`). Source: https://github.com/CyanoHao/Resource-Han-Rounded/releases/tag/v1.910
- `Nunito-UI.woff2`: Latin subset of Nunito, licensed under SIL OFL 1.1 (`Nunito-OFL.txt`). Source: https://github.com/google/fonts/tree/main/ofl/nunito

`scripts/ui-font.py` and its existing CI coverage check maintain the archived Chinese subset. Refresh it with `uv run --with 'fonttools[woff]' python scripts/ui-font.py --source /path/to/ResourceHanRoundedCN-VF.otf` when needed. The active UI font stack does not depend on this subset.
