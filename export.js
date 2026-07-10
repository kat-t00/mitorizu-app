// 画像（PNG）出力・PDF出力（ブラウザの印刷機能を利用）。
// genogram_web/export.jsと同じ仕組み（SVGをクローン→bbox計測→canvas化 or window.print）を踏襲。
// 表示モード切り替えが無い分シンプル。

(function (Madori) {
  // 画面操作専用で出力に含めたくない要素のセレクタ：
  // 背景グリッド(#layer-grid)は画面表示専用の目安線で、実データの一部ではない
  // （常時-4000〜4000の巨大な矩形を持つため、非表示にせずgetBBox()を呼ぶと
  // 見取り図の実サイズを無視した8000x8000という巨大な範囲になり、書き出し用canvasの
  // 生成に失敗する＝toBlob()がnullを返しcreateObjectURLが例外を投げる）。
  // リサイズハンドル・回転ハンドル・当たり判定用の透明矩形も、印刷物には不要な
  // 操作用UIなので同様に除外する。
  const NON_PRINT_SELECTORS = ["#layer-grid", ".room-resize-handle", ".fixture-rotate-handle", ".fixture-hit-area", ".fixture-editor-hint"];

  function withHiddenNonPrintElements(svgElement, callback) {
    const elements = NON_PRINT_SELECTORS.flatMap((selector) => Array.from(svgElement.querySelectorAll(selector)));
    const previousDisplay = elements.map((el) => el.style.display);
    elements.forEach((el) => { el.style.display = "none"; });
    try {
      return callback();
    } finally {
      elements.forEach((el, i) => { el.style.display = previousDisplay[i]; });
    }
  }

  function getContentBBox(svgElement) {
    const bbox = withHiddenNonPrintElements(svgElement, () => svgElement.getBBox());
    const margin = 20;
    if (bbox.width === 0 && bbox.height === 0) {
      // 何も配置していない状態での出力を弾く（0サイズのcanvas生成を避ける）
      return { x: -margin, y: -margin, width: margin * 2, height: margin * 2 };
    }
    return {
      x: bbox.x - margin,
      y: bbox.y - margin,
      width: bbox.width + margin * 2,
      height: bbox.height + margin * 2,
    };
  }

  // 部屋・家具の色や線はstyle.cssのクラス指定（.room-fill、.fixture-icon等）に頼っている。
  // これは画面表示では問題ないが、SVGを単独ファイルとして書き出す（クローンして
  // XMLSerializerで文字列化しImg化する）と、外部スタイルシートの参照が失われ、
  // 色指定の無いSVG要素はすべて既定色の黒で塗りつぶされてしまう
  // （実際にPNG出力が真っ黒になるバグとして発覚）。
  // document.styleSheetsから実行時に拾う案も試したが、file://で開いた場合
  // （このアプリの標準の使い方）は外部<link>のcssRulesへのアクセスがブラウザの
  // セキュリティ制限でSecurityErrorになり読み取れないことが判明した。
  // そのため、SVGの見た目に関わる部分のスタイルだけをここに直接複製して埋め込む。
  // **style.cssの.room-*・.fixture-*・.annotation-*系クラスを変更した時は、
  // このEXPORT_SVG_STYLEも一緒に更新すること。**（ハンドル・当たり判定用の
  // クラスは出力前に要素ごと除去されるためここに含める必要はない）
  const EXPORT_SVG_STYLE = `
    .room-fill { fill: #fff8ee; stroke: none; }
    .room-wall-line { stroke: #4a3418; stroke-width: 3; stroke-linecap: square; }
    .room-label-bg { fill: rgba(255, 253, 249, 0.88); stroke: none; }
    .room-label { font-size: 14px; font-weight: bold; fill: #2f3b52; }
    .room-tatami { font-size: 11px; fill: #6b7c93; }
    .fixture-node .fixture-icon { fill: #ffffff; stroke: #2f3b52; stroke-width: 2; color: #2f3b52; }
    .fixture-node.fixture-door .fixture-icon,
    .fixture-node.fixture-sliding_door .fixture-icon,
    .fixture-node.fixture-double_door .fixture-icon,
    .fixture-node.fixture-parent_child_door .fixture-icon,
    .fixture-node.fixture-folding_door .fixture-icon { stroke: #4a3418; }
    .fixture-node.fixture-stairs .fixture-icon { stroke: #4a3418; color: #4a3418; }
    .fixture-node.fixture-step .fixture-icon,
    .fixture-node.fixture-ramp .fixture-icon { stroke: #4d8fff; }
    .fixture-node.fixture-handrail_v .fixture-icon,
    .fixture-node.fixture-handrail_h .fixture-icon,
    .fixture-node.fixture-handrail_l .fixture-icon { stroke: #e0672a; fill: #e0672a; }
    .fixture-node.fixture-conflict .fixture-icon { stroke: #e11d48; }
    .fixture-label { font-size: 11px; fill: #6b7c93; }
    .fixture-mini-label { font-size: 10px; fill: #2f3b52; stroke: none; }
    .custom-fixture-name { font-weight: bold; }
    .annotation-bg { fill: #fff3d6; stroke: #e8c874; stroke-width: 1.5; }
    .annotation-text { font-size: 13px; fill: #2f3b52; white-space: pre; }
  `;

  function buildExportSvg(svgElement, bbox, options) {
    const clone = svgElement.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", bbox.width);
    clone.setAttribute("height", bbox.height);
    clone.setAttribute("viewBox", `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`);

    const styleEl = document.createElementNS("http://www.w3.org/2000/svg", "style");
    styleEl.textContent = EXPORT_SVG_STYLE;
    clone.insertBefore(styleEl, clone.firstChild);

    // 背景グリッド・リサイズ/回転ハンドル・当たり判定用の透明矩形は画面操作専用なので、
    // 出力物には含めない
    NON_PRINT_SELECTORS.forEach((selector) => {
      clone.querySelectorAll(selector).forEach((el) => el.remove());
    });

    if (options && options.transparentFloor) {
      // 部屋の床のクリーム色を消す（白基調の研修様式などに貼り付ける用途）。
      // クラス指定(EXPORT_SVG_STYLE)より優先させるため、要素に直接style属性で上書きする
      clone.querySelectorAll(".room-fill").forEach((el) => { el.style.fill = "none"; });
    }

    if (!(options && options.transparent)) {
      const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      background.setAttribute("x", bbox.x);
      background.setAttribute("y", bbox.y);
      background.setAttribute("width", bbox.width);
      background.setAttribute("height", bbox.height);
      background.setAttribute("fill", "#fffdf9");
      clone.insertBefore(background, clone.firstChild);
    }
    return clone;
  }

  function exportToPng(svgElement, fileName, options) {
    const bbox = getContentBBox(svgElement);
    const exportSvg = buildExportSvg(svgElement, bbox, options);
    const svgString = new XMLSerializer().serializeToString(exportSvg);
    const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = bbox.width * scale;
      canvas.height = bbox.height * scale;
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, bbox.width, bbox.height);
      URL.revokeObjectURL(url);

      canvas.toBlob((blob) => {
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(downloadUrl);
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      alert("画像出力に失敗しました。");
    };
    img.src = url;
  }

  function exportToPdf(svgElement, title, noteText, options) {
    const bbox = getContentBBox(svgElement);
    const exportSvg = buildExportSvg(svgElement, bbox, options);
    exportSvg.removeAttribute("width");
    exportSvg.removeAttribute("height");

    const printArea = document.getElementById("print-area");
    printArea.innerHTML = "";

    const heading = document.createElement("h2");
    heading.textContent = title;
    printArea.appendChild(heading);

    const todayLabel = new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
    const metaParts = [`作成日：${todayLabel}`];
    if (options && options.creatorName) metaParts.push(`作成者：${options.creatorName}`);
    const meta = document.createElement("p");
    meta.className = "print-meta";
    meta.textContent = metaParts.join("　");
    printArea.appendChild(meta);

    const orientation = (options && options.orientation) || "auto";
    const isLandscape = orientation === "auto" ? bbox.width > bbox.height : orientation === "landscape";
    printArea.classList.toggle("orientation-landscape", isLandscape);
    printArea.classList.toggle("orientation-portrait", !isLandscape);

    const body = document.createElement("div");
    body.className = "print-body";
    printArea.appendChild(body);

    const diagramCol = document.createElement("div");
    diagramCol.className = "print-diagram-col";
    const svgWrap = document.createElement("div");
    svgWrap.className = "print-svg-wrap";
    svgWrap.appendChild(exportSvg);
    diagramCol.appendChild(svgWrap);
    body.appendChild(diagramCol);

    const textCol = document.createElement("div");
    textCol.className = "print-text-col";
    body.appendChild(textCol);

    if (options && options.includeLegend) {
      const legendBlock = document.createElement("div");
      legendBlock.className = "print-legend";
      const legendHeading = document.createElement("h3");
      legendHeading.textContent = "図記号の意味";
      const legendList = document.createElement("ul");
      [
        "点＋線＝手すり（縦・横・L型）",
        "斜線ハッチングの短冊＝段差解消",
        "斜線ハッチングの三角＝スロープ",
        "白い扇形＝開き戸・両開き戸・親子扉が開く範囲",
        "2本線＋パネル＝引き戸、ジグザグ線＝折れ戸",
        "平行な2本線＝窓、壁の途切れ＝ドア・窓の開口部",
        "平行線の並び＋矢印＝階段（上り方向）",
      ].forEach((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        legendList.appendChild(li);
      });
      legendBlock.appendChild(legendHeading);
      legendBlock.appendChild(legendList);
      textCol.appendChild(legendBlock);
    }

    if (noteText && options && options.includeNote) {
      const noteBlock = document.createElement("div");
      noteBlock.className = "print-note";
      const noteHeading = document.createElement("h3");
      noteHeading.textContent = "📝 備考";
      const noteBody = document.createElement("p");
      noteBody.style.whiteSpace = "pre-wrap";
      noteBody.textContent = noteText;
      noteBlock.appendChild(noteHeading);
      noteBlock.appendChild(noteBody);
      textCol.appendChild(noteBlock);
    }

    let pageStyle = document.getElementById("print-page-style");
    if (!pageStyle) {
      pageStyle = document.createElement("style");
      pageStyle.id = "print-page-style";
      document.head.appendChild(pageStyle);
    }
    pageStyle.textContent = `@page { size: ${isLandscape ? "landscape" : "portrait"}; margin: 10mm; }`;
    printArea.style.height = isLandscape ? "188mm" : "275mm";

    window.print();
  }

  Madori.exporter = { exportToPng, exportToPdf };
})((window.Madori = window.Madori || {}));
