#!/usr/bin/env python3
"""index.html・style.css・各.jsファイルを1つのHTMLファイルにまとめて
madori_standalone.html（配布用）とmadori_事務所用.html（事業所内部利用用、
X（Twitter）への動線を含まない別内容）を作る。

開発（Claude Codeでの編集）は引き続きindex.html等の個別ファイルで行い、
変更したら最後にこのスクリプトを実行して両方を作り直す。

実行方法: python3 build_standalone.py
"""
import re
from pathlib import Path

BASE_DIR = Path(__file__).parent
INDEX_HTML = BASE_DIR / "index.html"
OUTPUT_HTML = BASE_DIR / "madori_standalone.html"
OUTPUT_HTML_OFFICE = BASE_DIR / "madori_事務所用.html"

JS_FILES = [
    "models.js",
    "canvas.js",
    "forms.js",
    "document_store.js",
    "export.js",
    "app.js",
]

# ヘッダー右上のXへの動線(app-credit)を丸ごと取り除くための正規表現。
# 事業所内部利用版では、外部SNSへの動線を含めない方針のため除去する。
APP_CREDIT_PATTERN = re.compile(
    r'\s*<a class="app-credit"[\s\S]*?</a>\n?'
)


def build_base_html():
    html = INDEX_HTML.read_text(encoding="utf-8")

    css_content = (BASE_DIR / "style.css").read_text(encoding="utf-8")
    html = html.replace(
        '<link rel="stylesheet" href="style.css" />',
        f"<style>\n{css_content}\n</style>",
    )

    for js_file in JS_FILES:
        js_content = (BASE_DIR / js_file).read_text(encoding="utf-8")
        html = html.replace(
            f'<script src="{js_file}"></script>',
            f"<script>\n{js_content}\n</script>",
        )

    if re.search(r'<script src="[^"]+\.js"></script>', html):
        raise RuntimeError("一部の<script src>が置換されずに残っています。JS_FILESの一覧を確認してください。")
    if '<link rel="stylesheet"' in html:
        raise RuntimeError("style.cssへのlinkタグが置換されずに残っています。")

    return html


def main():
    html = build_base_html()
    OUTPUT_HTML.write_text(html, encoding="utf-8")
    print(f"作成しました: {OUTPUT_HTML}")

    if not APP_CREDIT_PATTERN.search(html):
        raise RuntimeError("app-creditリンクが見つかりませんでした。index.htmlの構造が変わっていないか確認してください。")
    office_html = APP_CREDIT_PATTERN.sub("\n", html, count=1)
    OUTPUT_HTML_OFFICE.write_text(office_html, encoding="utf-8")
    print(f"作成しました: {OUTPUT_HTML_OFFICE}（Xへの動線なし）")


if __name__ == "__main__":
    main()
