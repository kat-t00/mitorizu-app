// SVGキャンバス：部屋（矩形・リサイズ可・壁に開口部を持てる）、家具・設備アイコン、
// テキスト注釈の描画とドラッグ操作。
// パン・ズーム・ワールド座標変換の基本部分はgenogram_web/canvas.jsと同じ設計をそのまま踏襲している
// （汎用ロジックのため、ジェノグラム固有の要素は一切含まない）。

(function (Madori) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const GRID = 20; // 背景グリッドの間隔（ワールド座標）。厳密な採寸ではなく「揃える」ための目安
  const SNAP_THRESHOLD = 10; // これ未満の差なら吸着する
  const WALL_SNAP_THRESHOLD = 24; // ドア・窓が壁に自動フィットする距離
  const HANDLE_SIZE = 12;
  const MIN_HIT = 28; // 家具アイコンの最小当たり判定サイズ（細い線だけの図形でもクリック・ドラッグしやすくする）
  const WALL_SIDES = ["top", "right", "bottom", "left"];

  let svg = null;
  let viewportGroup = null;
  let gridLayer = null;
  let layerRooms = null;
  let layerFixtures = null;
  let layerRoomLabels = null;
  let layerAnnotations = null;

  const viewTransform = { x: 0, y: 0, scale: 1 };
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 3;

  let currentDocument = null;
  const roomGroups = {};
  const fixtureGroups = {};
  const annotationGroups = {};
  const roomWallRedrawers = {}; // roomId -> 部屋の壁(開口部込み)を再描画する関数
  const roomLabelRepositioners = {}; // roomId -> 部屋名ラベル(最前面レイヤー)の位置を再計算する関数

  // リサイズ・回転ハンドルは「直近でクリック/ドラッグしたパーツ」だけに表示する。
  // 常時全部表示だと、パーツを密集させた時にハンドル同士が重なって掴みにくくなるため。
  // ownerKeyは "room:<id>" または "fixture:<id>" の形。
  let activeHandleOwner = null;
  const handleVisibilityRefreshers = {}; // ownerKey -> 自分のハンドルのdisplayを更新する関数

  function setActiveHandleOwner(ownerKey) {
    if (activeHandleOwner === ownerKey) return;
    const previous = activeHandleOwner;
    activeHandleOwner = ownerKey;
    if (previous && handleVisibilityRefreshers[previous]) handleVisibilityRefreshers[previous]();
    if (ownerKey && handleVisibilityRefreshers[ownerKey]) handleVisibilityRefreshers[ownerKey]();
  }

  let onRoomClick = null;
  let onFixtureClick = null;
  let onAnnotationClick = null;
  let onDragEnd = null;
  let onZoomChange = null;

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const key in attrs) el.setAttribute(key, attrs[key]);
    }
    return el;
  }

  function init(svgElement) {
    svg = svgElement;
    setupPanZoom();
    setupKeyboardNudge();
  }

  // 選択中の部屋・家具を矢印キーで微調整できるようにする。Shiftを押しながらだと
  // 大きさ（部屋は幅・高さ、壁付け家具は長さのみ）を変える。「リサイズハンドルを
  // 指で正確につまむのが難しい」場合の代替手段、かつ細かい位置調整の手段として。
  const NUDGE_STEP = 4;
  function setupKeyboardNudge() {
    document.addEventListener("keydown", (evt) => {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(evt.key)) return;
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      if (!activeHandleOwner) return;
      const [kind, id] = activeHandleOwner.split(/:(.+)/);
      const dxKey = evt.key === "ArrowRight" ? 1 : evt.key === "ArrowLeft" ? -1 : 0;
      const dyKey = evt.key === "ArrowDown" ? 1 : evt.key === "ArrowUp" ? -1 : 0;
      const step = NUDGE_STEP;

      if (kind === "room") {
        const room = currentDocument.rooms.find((r) => r.id === id);
        if (!room) return;
        evt.preventDefault();
        if (evt.shiftKey) {
          room.width = Math.max(GRID, room.width + dxKey * step);
          room.height = Math.max(GRID, room.height + dyKey * step);
        } else {
          const containedIds = computeContainedFixtureIds(room);
          room.x += dxKey * step;
          room.y += dyKey * step;
          shiftFixturesByIds(containedIds, dxKey * step, dyKey * step);
        }
        if (onDragEnd) onDragEnd();
        return;
      }

      if (kind === "fixture") {
        const fixture = currentDocument.fixtures.find((f) => f.id === id);
        if (!fixture) return;
        evt.preventDefault();
        if (fixture.wall) {
          const room = currentDocument.rooms.find((r) => r.id === fixture.wall.roomId);
          if (!room) return;
          if (evt.shiftKey) {
            const along = fixture.wall.side === "top" || fixture.wall.side === "bottom" ? dxKey : dyKey;
            fixture.width = Math.max(GRID, fixture.width + along * step);
          } else {
            const along = fixture.wall.side === "top" || fixture.wall.side === "bottom" ? dxKey : dyKey;
            fixture.wall.offset += along * step;
          }
          clampFixtureToWall(fixture, room);
        } else if (evt.shiftKey) {
          fixture.width = Math.max(GRID, fixture.width + dxKey * step);
          fixture.height = Math.max(GRID, fixture.height + dyKey * step);
        } else {
          fixture.x += dxKey * step;
          fixture.y += dyKey * step;
        }
        if (onDragEnd) onDragEnd();
      }
    });
  }

  // ===== パン・ズーム（genogram_webと同じ設計） =====
  function setupPanZoom() {
    svg.addEventListener("pointerdown", (evt) => {
      if (evt.target !== svg) return;
      // 何もない場所を押したら、直前まで表示していたハンドルを隠す（選択解除）
      setActiveHandleOwner(null);
      const startClientX = evt.clientX;
      const startClientY = evt.clientY;
      const startTransform = { x: viewTransform.x, y: viewTransform.y };

      function onMove(moveEvt) {
        viewTransform.x = startTransform.x + (moveEvt.clientX - startClientX);
        viewTransform.y = startTransform.y + (moveEvt.clientY - startClientY);
        applyViewTransform();
      }
      function onUp() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    svg.addEventListener(
      "wheel",
      (evt) => {
        evt.preventDefault();
        const rect = svg.getBoundingClientRect();
        const screenX = evt.clientX - rect.left;
        const screenY = evt.clientY - rect.top;
        const worldBefore = screenToWorld(evt.clientX, evt.clientY);
        const factor = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
        viewTransform.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewTransform.scale * factor));
        viewTransform.x = screenX - viewTransform.scale * worldBefore.x;
        viewTransform.y = screenY - viewTransform.scale * worldBefore.y;
        applyViewTransform();
      },
      { passive: false }
    );
  }

  function setZoomChangeHandler(handler) {
    onZoomChange = handler;
    if (onZoomChange) onZoomChange(Math.round(viewTransform.scale * 100));
  }

  function applyViewTransform() {
    if (!viewportGroup) return;
    viewportGroup.setAttribute(
      "transform",
      `translate(${viewTransform.x}, ${viewTransform.y}) scale(${viewTransform.scale})`
    );
    if (onZoomChange) onZoomChange(Math.round(viewTransform.scale * 100));
  }

  function zoomBy(factor) {
    const rect = svg.getBoundingClientRect();
    const screenX = rect.width / 2;
    const screenY = rect.height / 2;
    const worldBefore = screenToWorld(rect.left + screenX, rect.top + screenY);
    viewTransform.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewTransform.scale * factor));
    viewTransform.x = screenX - viewTransform.scale * worldBefore.x;
    viewTransform.y = screenY - viewTransform.scale * worldBefore.y;
    applyViewTransform();
  }

  function screenToWorld(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    return {
      x: (screenX - viewTransform.x) / viewTransform.scale,
      y: (screenY - viewTransform.y) / viewTransform.scale,
    };
  }

  function computeContentBounds(doc) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    doc.rooms.forEach((r) => {
      any = true;
      minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x + r.width);
      minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y + r.height);
    });
    doc.fixtures.forEach((f) => {
      // 壁付けの家具は中心ではなく壁沿いに描かれる(0〜height方向)ため、
      // 厳密な矩形計算はせず余裕を持たせた範囲で近似する（fitToViewが多少広く取る程度は実害が無い）。
      any = true;
      minX = Math.min(minX, f.x - f.width); maxX = Math.max(maxX, f.x + f.width);
      minY = Math.min(minY, f.y - f.height); maxY = Math.max(maxY, f.y + f.height);
    });
    doc.annotations.forEach((a) => {
      any = true;
      minX = Math.min(minX, a.x - 40); maxX = Math.max(maxX, a.x + 40);
      minY = Math.min(minY, a.y - 12); maxY = Math.max(maxY, a.y + 12);
    });
    if (!any) return null;
    return { minX, minY, maxX, maxY };
  }

  function fitToView(doc) {
    const bounds = computeContentBounds(doc);
    if (!bounds) {
      viewTransform.x = 0;
      viewTransform.y = 0;
      viewTransform.scale = 1;
      applyViewTransform();
      return;
    }
    const rect = svg.getBoundingClientRect();
    const margin = 60;
    const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
    const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
    const FIT_MAX_SCALE = 1.8;
    const scale = Math.min(
      FIT_MAX_SCALE,
      Math.max(MIN_SCALE, Math.min((rect.width - margin * 2) / contentWidth, (rect.height - margin * 2) / contentHeight))
    );
    const contentCenterX = (bounds.minX + bounds.maxX) / 2;
    const contentCenterY = (bounds.minY + bounds.maxY) / 2;
    viewTransform.scale = scale;
    viewTransform.x = rect.width / 2 - scale * contentCenterX;
    viewTransform.y = rect.height / 2 - scale * contentCenterY;
    applyViewTransform();
  }

  function isWorldPointVisible(x, y, margin) {
    const m = margin || 0;
    const rect = svg.getBoundingClientRect();
    const topLeft = screenToWorld(rect.left, rect.top);
    const bottomRight = screenToWorld(rect.right, rect.bottom);
    return x >= topLeft.x - m && x <= bottomRight.x + m && y >= topLeft.y - m && y <= bottomRight.y + m;
  }

  // ===== ハンドラ登録 =====
  function setRoomClickHandler(h) { onRoomClick = h; }
  function setFixtureClickHandler(h) { onFixtureClick = h; }
  function setAnnotationClickHandler(h) { onAnnotationClick = h; }
  function setDragEndHandler(h) { onDragEnd = h; }

  // ===== スナップ（吸着） =====
  // 部屋を動かす時：グリッド、または他の部屋の辺（左右/上下どちらの向きの隣接も）に吸着する。
  function computeSnap1D(newPos, size, others, threshold) {
    const candidates = [Math.round(newPos / GRID) * GRID];
    others.forEach((o) => {
      candidates.push(o.pos, o.pos + o.size, o.pos - size, o.pos + o.size - size);
    });
    let best = newPos;
    let bestDist = threshold;
    candidates.forEach((c) => {
      const d = Math.abs(c - newPos);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    });
    return best;
  }

  function snapRoomPosition(room, newX, newY) {
    const others = currentDocument.rooms
      .filter((r) => r.id !== room.id)
      .map((r) => ({ pos: r.x, size: r.width }));
    const othersY = currentDocument.rooms
      .filter((r) => r.id !== room.id)
      .map((r) => ({ pos: r.y, size: r.height }));
    return {
      x: computeSnap1D(newX, room.width, others, SNAP_THRESHOLD),
      y: computeSnap1D(newY, room.height, othersY, SNAP_THRESHOLD),
    };
  }

  // リサイズ時、動いている辺だけを他の部屋の辺・グリッドに吸着させる
  function snapPoint(value, points, threshold) {
    let best = value;
    let bestDist = threshold;
    points.forEach((p) => {
      const d = Math.abs(p - value);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    });
    return best;
  }

  // 部屋のリサイズ用：X方向・Y方向それぞれ独立に、動いている辺の位置を
  // グリッド・他の部屋の辺へスナップする（四隅どの角をドラッグしても使える汎用版）。
  function snapRoomEdgeX(room, rawX) {
    const points = [Math.round(rawX / GRID) * GRID];
    currentDocument.rooms.forEach((r) => {
      if (r.id === room.id) return;
      points.push(r.x, r.x + r.width);
    });
    return snapPoint(rawX, points, SNAP_THRESHOLD);
  }

  function snapRoomEdgeY(room, rawY) {
    const points = [Math.round(rawY / GRID) * GRID];
    currentDocument.rooms.forEach((r) => {
      if (r.id === room.id) return;
      points.push(r.y, r.y + r.height);
    });
    return snapPoint(rawY, points, SNAP_THRESHOLD);
  }

  function snapToGridOnly(value) {
    return Math.round(value / GRID) * GRID;
  }

  // 壁から離れた自由配置の家具用：グリッド線のごく近く(GRID=20に対して5だけ)にいる時だけ
  // 吸着し、そうでなければドラッグした位置をそのまま使う（常にグリッドへ丸めてしまうと、
  // ソファなどを壁から少し離した意図的な位置に置きたい時に、思った場所へ置けなくなって
  // しまうため）。SNAP_THRESHOLD(10)はGRID(20)のちょうど半分＝どんな位置でも必ずどちらかの
  // グリッド線から10以内になってしまい実質的に常時スナップと同じになるため、
  // ここでは意図的にもっと小さい専用のしきい値を使う。
  const FREE_SNAP_THRESHOLD = 5;
  function snapToGridSoft(value) {
    const snapped = snapToGridOnly(value);
    return Math.abs(snapped - value) <= FREE_SNAP_THRESHOLD ? snapped : value;
  }

  // 壁付けでない家具（ベッド・便器など）も、部屋の壁際までドラッグすると辺がピタッと
  // 吸着するようにする（壁に開口部を作るドア・窓とは違い、単に位置を合わせるだけ）。
  // 90度単位の回転のみ対応（斜めの角度では軸に沿った吸着自体が意味を持たないため）。
  // ドア・窓のWALL_SNAP_THRESHOLD(24)をそのまま使うと、壁からあえて少し隙間を空けて
  // 家具を置きたい時にも吸い寄せられてしまい配置の自由度が下がるため、家具の壁吸着だけは
  // もっと狭い専用のしきい値にする（壁にぴったり付けたい時だけ効くように）。
  const FURNITURE_WALL_SNAP_THRESHOLD = 10;
  function computeFurnitureWallSnap(width, height, rotation, rawX, rawY) {
    const rot = ((Math.round(rotation) % 360) + 360) % 360;
    if (rot !== 0 && rot !== 90 && rot !== 180 && rot !== 270) return null;
    const swapped = rot === 90 || rot === 270;
    const halfW = (swapped ? height : width) / 2;
    const halfH = (swapped ? width : height) / 2;
    let bestX = null;
    let bestY = null;
    currentDocument.rooms.forEach((room) => {
      const overlapsX =
        rawX + halfW > room.x - FURNITURE_WALL_SNAP_THRESHOLD && rawX - halfW < room.x + room.width + FURNITURE_WALL_SNAP_THRESHOLD;
      const overlapsY =
        rawY + halfH > room.y - FURNITURE_WALL_SNAP_THRESHOLD && rawY - halfH < room.y + room.height + FURNITURE_WALL_SNAP_THRESHOLD;
      if (overlapsX) {
        const distTop = Math.abs(rawY - halfH - room.y);
        if (distTop < FURNITURE_WALL_SNAP_THRESHOLD && (!bestY || distTop < bestY.dist)) {
          bestY = { dist: distTop, y: room.y + halfH };
        }
        const distBottom = Math.abs(rawY + halfH - (room.y + room.height));
        if (distBottom < FURNITURE_WALL_SNAP_THRESHOLD && (!bestY || distBottom < bestY.dist)) {
          bestY = { dist: distBottom, y: room.y + room.height - halfH };
        }
      }
      if (overlapsY) {
        const distLeft = Math.abs(rawX - halfW - room.x);
        if (distLeft < FURNITURE_WALL_SNAP_THRESHOLD && (!bestX || distLeft < bestX.dist)) {
          bestX = { dist: distLeft, x: room.x + halfW };
        }
        const distRight = Math.abs(rawX + halfW - (room.x + room.width));
        if (distRight < FURNITURE_WALL_SNAP_THRESHOLD && (!bestX || distRight < bestX.dist)) {
          bestX = { dist: distRight, x: room.x + room.width - halfW };
        }
      }
    });
    if (!bestX && !bestY) return null;
    return { x: bestX ? bestX.x : null, y: bestY ? bestY.y : null };
  }

  // ===== 壁ジオメトリ（部屋の辺・ドア/窓の開口部・自動フィット） =====
  // 各辺のオフセットは必ず決まった向き（上/下=左→右、左/右=上→下）からの距離とする。
  // fixture.wall.offsetはこの向きに沿った「開口部の中心位置」。
  function wallEndpointsLocal(room, side) {
    switch (side) {
      case "top": return { p1: { x: 0, y: 0 }, p2: { x: room.width, y: 0 }, length: room.width };
      case "bottom": return { p1: { x: 0, y: room.height }, p2: { x: room.width, y: room.height }, length: room.width };
      case "left": return { p1: { x: 0, y: 0 }, p2: { x: 0, y: room.height }, length: room.height };
      case "right": return { p1: { x: room.width, y: 0 }, p2: { x: room.width, y: room.height }, length: room.height };
      default: return { p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, length: 0 };
    }
  }

  function wallLength(room, side) {
    return side === "top" || side === "bottom" ? room.width : room.height;
  }

  function wallPointWorld(room, side, offset) {
    const { p1, p2, length } = wallEndpointsLocal(room, side);
    const t = length === 0 ? 0 : offset / length;
    return {
      x: room.x + p1.x + (p2.x - p1.x) * t,
      y: room.y + p1.y + (p2.y - p1.y) * t,
    };
  }

  // 部屋に取り付いている全てのドア・窓の開口部一覧を辺ごとにまとめる。
  // 加えて、別の部屋を密着させて共有した壁については、相手側に付いている開口部も
  // この部屋の壁描画に反映する（例：部屋Aに開口部を付けた状態で無関係な部屋Bを
  // ぴったりくっつけると、Bの無傷な壁がAの開口部を視覚的に塞いでしまっていた不具合の対策。
  // 片方にしか開口部が無くても、両方の壁描画で「開いている」ように見せる）
  const ADJACENT_WALL_EPS = 0.5;
  const OPPOSITE_SIDE = { top: "bottom", bottom: "top", left: "right", right: "left" };
  function collectWallOpenings(room) {
    const openings = { top: [], right: [], bottom: [], left: [] };
    currentDocument.fixtures.forEach((f) => {
      if (f.wall && f.wall.roomId === room.id) {
        openings[f.wall.side].push({ start: f.wall.offset - f.width / 2, end: f.wall.offset + f.width / 2, fixtureId: f.id });
      }
    });
    WALL_SIDES.forEach((side) => {
      const axisIsX = side === "top" || side === "bottom";
      const myFixed = axisIsX ? room.y + (side === "bottom" ? room.height : 0) : room.x + (side === "right" ? room.width : 0);
      const myAlongOrigin = axisIsX ? room.x : room.y;
      const myLength = axisIsX ? room.width : room.height;
      const otherSide = OPPOSITE_SIDE[side];
      currentDocument.rooms.forEach((other) => {
        if (other.id === room.id) return;
        const otherFixed = axisIsX
          ? other.y + (otherSide === "bottom" ? other.height : 0)
          : other.x + (otherSide === "right" ? other.width : 0);
        if (Math.abs(otherFixed - myFixed) > ADJACENT_WALL_EPS) return;
        const otherAlongOrigin = axisIsX ? other.x : other.y;
        const otherLength = axisIsX ? other.width : other.height;
        const overlapStart = Math.max(myAlongOrigin, otherAlongOrigin);
        const overlapEnd = Math.min(myAlongOrigin + myLength, otherAlongOrigin + otherLength);
        if (overlapEnd <= overlapStart) return;
        currentDocument.fixtures.forEach((f) => {
          if (f.wall && f.wall.roomId === other.id && f.wall.side === otherSide) {
            const worldStart = otherAlongOrigin + f.wall.offset - f.width / 2;
            const worldEnd = otherAlongOrigin + f.wall.offset + f.width / 2;
            openings[side].push({ start: worldStart - myAlongOrigin, end: worldEnd - myAlongOrigin, fixtureId: f.id });
          }
        });
      });
    });
    return openings;
  }

  // 同じ壁の同じ辺で、2つ以上の開口部が重なっているものを検出する
  // （例：ドアと窓を同じ位置に置いてしまった場合の警告用）。
  function detectWallConflicts(openingsBySide) {
    const conflictIds = new Set();
    WALL_SIDES.forEach((side) => {
      const sorted = openingsBySide[side].slice().sort((a, b) => a.start - b.start);
      let runningMaxEnd = -Infinity;
      let runningMaxId = null;
      sorted.forEach((o) => {
        if (o.start < runningMaxEnd) {
          conflictIds.add(o.fixtureId);
          conflictIds.add(runningMaxId);
        }
        if (o.end > runningMaxEnd) {
          runningMaxEnd = o.end;
          runningMaxId = o.fixtureId;
        }
      });
    });
    return conflictIds;
  }

  // 壁の開口部の重なり状態を、対象の部屋に付いている家具の見た目(赤い警告表示)に反映する
  function refreshWallConflictHighlights(room) {
    const conflicts = detectWallConflicts(collectWallOpenings(room));
    currentDocument.fixtures.forEach((f) => {
      if (f.wall && f.wall.roomId === room.id) {
        const el = fixtureGroups[f.id];
        if (el) el.classList.toggle("fixture-conflict", conflicts.has(f.id));
      }
    });
  }

  // 開口部を除いた「実線を引くべき区間」のリスト（0〜lengthの範囲のペア）を返す
  function computeWallSegments(length, openings) {
    const sorted = openings.slice().sort((a, b) => a.start - b.start);
    let cursor = 0;
    const segments = [];
    sorted.forEach((o) => {
      const s = Math.max(0, Math.min(length, o.start));
      const e = Math.max(0, Math.min(length, o.end));
      if (s > cursor) segments.push([cursor, s]);
      cursor = Math.max(cursor, e);
    });
    if (cursor < length) segments.push([cursor, length]);
    return segments;
  }

  // 点(px,py)に最も近い部屋の壁を探し、壁沿いのオフセット(開口部の中心位置)を返す。
  // ドア・窓をドラッグしている時の「壁への自動フィット」に使う。閾値内に壁が無ければnull。
  function computeWallAttachment(fixtureWidth, px, py, threshold) {
    let best = null;
    currentDocument.rooms.forEach((room) => {
      WALL_SIDES.forEach((side) => {
        const { p1, p2, length } = wallEndpointsLocal(room, side);
        const worldP1 = { x: room.x + p1.x, y: room.y + p1.y };
        const worldP2 = { x: room.x + p2.x, y: room.y + p2.y };
        const isHorizontal = worldP1.y === worldP2.y;
        const perpDist = isHorizontal ? Math.abs(py - worldP1.y) : Math.abs(px - worldP1.x);
        if (perpDist > threshold) return;
        const along = isHorizontal ? px - worldP1.x : py - worldP1.y;
        const margin = Math.min(fixtureWidth / 2, length / 2);
        if (along < -threshold || along > length + threshold) return;
        const offset = Math.min(Math.max(along, margin), Math.max(length - margin, margin));
        if (!best || perpDist < best.perpDist) {
          best = { roomId: room.id, side, offset, perpDist };
        }
      });
    });
    return best;
  }

  // 部屋の移動・リサイズ後、その部屋の壁に取り付いているドア・窓の位置を追従させる
  function repositionAttachedFixtures(room) {
    currentDocument.fixtures.forEach((f) => {
      if (!f.wall || f.wall.roomId !== room.id) return;
      clampFixtureToWall(f, room);
      const el = fixtureGroups[f.id];
      if (el) el.setAttribute("transform", `translate(${f.x}, ${f.y}) rotate(${f.rotation})`);
    });
  }

  // 部屋の矩形内に収まっている（壁付けではない）家具のIDを集める。
  // 部屋のドラッグ開始時点で一度だけ計算し、その部屋が動いている間はこのIDの集合を
  // 固定のまま使う（ドラッグ中に境界をまたいで出入りするような挙動を避けるため）。
  function computeContainedFixtureIds(room) {
    return currentDocument.fixtures
      .filter((f) => !f.wall)
      .filter((f) => f.x >= room.x && f.x <= room.x + room.width && f.y >= room.y && f.y <= room.y + room.height)
      .map((f) => f.id);
  }

  function shiftFixturesByIds(ids, dx, dy) {
    if (dx === 0 && dy === 0) return;
    ids.forEach((id) => {
      const f = currentDocument.fixtures.find((ff) => ff.id === id);
      if (!f) return;
      f.x += dx;
      f.y += dy;
      const el = fixtureGroups[f.id];
      if (el) el.setAttribute("transform", `translate(${f.x}, ${f.y}) rotate(${f.rotation})`);
    });
  }

  // リサイズ中は「固定した開始地点からの累計移動量」で計算する（他のリサイズ処理と同じ
  // 理由：閾値未満の移動が繰り返し無効化されるのを防ぐため）ため、家具側も直前フレームからの
  // 差分ではなく、ドラッグ開始時点の元位置を基準に絶対座標で計算し直す必要がある。
  function computeContainedFixtureOrigins(room) {
    const origins = {};
    computeContainedFixtureIds(room).forEach((id) => {
      const f = currentDocument.fixtures.find((ff) => ff.id === id);
      if (f) origins[id] = { x: f.x, y: f.y };
    });
    return origins;
  }

  function applyFixtureOriginShift(origins, dx, dy) {
    Object.keys(origins).forEach((id) => {
      const f = currentDocument.fixtures.find((ff) => ff.id === id);
      if (!f) return;
      f.x = origins[id].x + dx;
      f.y = origins[id].y + dy;
      const el = fixtureGroups[f.id];
      if (el) el.setAttribute("transform", `translate(${f.x}, ${f.y}) rotate(${f.rotation})`);
    });
  }

  function redrawRoomWalls(roomId) {
    const redraw = roomWallRedrawers[roomId];
    if (redraw) redraw();
    const room = currentDocument.rooms.find((r) => r.id === roomId);
    if (room) refreshWallConflictHighlights(room);
  }

  // ===== 背景グリッド =====
  function renderGrid() {
    gridLayer.innerHTML = "";
    const pattern = svgEl("pattern", {
      id: "madori-grid-pattern",
      width: GRID,
      height: GRID,
      patternUnits: "userSpaceOnUse",
    });
    pattern.appendChild(
      svgEl("circle", { cx: 1, cy: 1, r: 1, fill: "#d3e3f0" })
    );
    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = svgEl("defs", {});
      svg.insertBefore(defs, svg.firstChild);
    }
    defs.innerHTML = "";
    defs.appendChild(pattern);
    // グリッドは見た目だけの目安線で操作対象ではないため、pointer-events:noneにして
    // クリックがすり抜けてsvg自体（パン開始・選択解除の判定基準）に届くようにする。
    // これが無いと、キャンバスのほぼ全域を覆うこの矩形が背景クリックを横取りしてしまい、
    // 「何もない場所」判定(evt.target === svg)が成立しなくなる。
    gridLayer.appendChild(
      svgEl("rect", { x: -4000, y: -4000, width: 8000, height: 8000, fill: "url(#madori-grid-pattern)", style: "pointer-events: none;" })
    );
  }

  // ===== 汎用ドラッグ =====
  // snapFn(rawX,rawY)は{x,y}に加えて任意の追加フィールド（rotation、wallなど）を返してよい。
  // setPosはその結果オブジェクトをそのまま受け取り、対象ごとに必要なフィールドだけ使う。
  function attachDrag(group, getPos, setPos, snapFn, onClick) {
    let dragging = false;
    let startX = 0, startY = 0, originX = 0, originY = 0, moved = false;

    group.addEventListener("pointerdown", (evt) => {
      dragging = true;
      moved = false;
      group.setPointerCapture(evt.pointerId);
      evt.stopPropagation();
      const world = screenToWorld(evt.clientX, evt.clientY);
      startX = world.x;
      startY = world.y;
      const pos = getPos();
      originX = pos.x;
      originY = pos.y;
      evt.preventDefault();
    });

    group.addEventListener("pointermove", (evt) => {
      if (!dragging) return;
      const world = screenToWorld(evt.clientX, evt.clientY);
      const rawX = originX + (world.x - startX);
      const rawY = originY + (world.y - startY);
      const snapped = snapFn(rawX, rawY);
      // 「動いた」かどうかは生のマウス移動量ではなく、スナップ後の座標が実際に
      // 開始位置と変わったかで判定する。生の移動量が閾値未満でも、グリッド境界を
      // またいでスナップ後の値が変わることがあり、その場合は実データが変わっている
      // のでmoved=trueにしないと、見た目は動いたのに保存されない（Undoにも乗らない）
      // というデータの不整合が起きる。
      if (snapped.x !== originX || snapped.y !== originY) moved = true;
      setPos(snapped);
    });

    group.addEventListener("pointerup", (evt) => {
      dragging = false;
      group.releasePointerCapture(evt.pointerId);
      if (!moved && onClick) onClick(evt.clientX, evt.clientY);
      if (moved && onDragEnd) onDragEnd();
    });
  }

  // リサイズハンドル：無地の四角だけだと「ここを掴めば大きさを変えられる」と
  // 気づきにくい（特にホバーでカーソルが変わらないタッチ操作では手がかりが皆無になる）
  // という指摘を受けて、斜め方向の両矢印アイコンを重ねて描くようにした。
  // "\"方向(nwse-resize)の矢印を基準に描き、"/"方向(nesw-resize)は90度回転するだけで作れる
  // （原点中心の回転で(-4,-4)-(4,4)の線分は(4,-4)-(-4,4)の線分にちょうど一致するため）。
  function buildResizeHandle(cursor) {
    const g = svgEl("g", { class: "room-resize-handle" });
    g.appendChild(svgEl("rect", {
      x: -HANDLE_SIZE / 2, y: -HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE,
      class: "resize-handle-box",
    }));
    const arrowRotation = cursor === "nesw-resize" ? 90 : 0;
    const arrow = svgEl("g", { class: "resize-handle-arrow", transform: `rotate(${arrowRotation})` });
    arrow.appendChild(svgEl("line", { x1: -4, y1: -4, x2: 4, y2: 4 }));
    arrow.appendChild(svgEl("polyline", { points: "-1,-4 -4,-4 -4,-1", fill: "none" }));
    arrow.appendChild(svgEl("polyline", { points: "1,4 4,4 4,1", fill: "none" }));
    g.appendChild(arrow);
    g.style.cursor = cursor;
    return g;
  }

  // ===== 部屋 =====
  function addRoomNode(room) {
    const group = svgEl("g", { class: "room-node" });
    group.style.cursor = "grab";

    const fillRect = svgEl("rect", {
      x: 0, y: 0, width: room.width, height: room.height,
      class: "room-fill", rx: 4,
    });
    group.appendChild(fillRect);

    const wallsGroup = svgEl("g", { class: "room-walls" });
    group.appendChild(wallsGroup);

    function redrawWalls() {
      wallsGroup.innerHTML = "";
      const openingsBySide = collectWallOpenings(room);
      WALL_SIDES.forEach((side) => {
        const { p1, p2, length } = wallEndpointsLocal(room, side);
        computeWallSegments(length, openingsBySide[side]).forEach(([s, e]) => {
          const ts = length === 0 ? 0 : s / length;
          const te = length === 0 ? 0 : e / length;
          wallsGroup.appendChild(
            svgEl("line", {
              x1: p1.x + (p2.x - p1.x) * ts, y1: p1.y + (p2.y - p1.y) * ts,
              x2: p1.x + (p2.x - p1.x) * te, y2: p1.y + (p2.y - p1.y) * te,
              class: "room-wall-line",
            })
          );
        });
      });
    }
    redrawWalls();
    roomWallRedrawers[room.id] = redrawWalls;

    // 四隅すべてにリサイズハンドルを置く（右下だけだと不便という指摘を受けて全角対応化）。
    // ドラッグした角の「対角」が世界座標上で動かないように計算する（handleDefsのdx/dy参照）。
    const CORNER_DEFS = [
      { key: "tl", cursor: "nwse-resize", dx: 0, dy: 0 },
      { key: "tr", cursor: "nesw-resize", dx: 1, dy: 0 },
      { key: "bl", cursor: "nesw-resize", dx: 0, dy: 1 },
      { key: "br", cursor: "nwse-resize", dx: 1, dy: 1 },
    ];
    const cornerHandles = {};
    CORNER_DEFS.forEach((def) => {
      const el = buildResizeHandle(def.cursor);
      el.setAttribute("transform", `translate(${def.dx * room.width}, ${def.dy * room.height})`);
      group.appendChild(el);
      cornerHandles[def.key] = el;
    });

    function repositionCornerHandles() {
      CORNER_DEFS.forEach((def) => {
        const el = cornerHandles[def.key];
        el.setAttribute("transform", `translate(${def.dx * room.width}, ${def.dy * room.height})`);
      });
    }

    // このパーツが「直近で操作したもの」の時だけハンドルを見せる
    const handleOwnerKey = `room:${room.id}`;
    function refreshHandleVisibility() {
      const isActive = activeHandleOwner === handleOwnerKey;
      CORNER_DEFS.forEach((def) => {
        cornerHandles[def.key].style.display = isActive ? "" : "none";
      });
      group.classList.toggle("is-selected", isActive);
    }
    handleVisibilityRefreshers[handleOwnerKey] = refreshHandleVisibility;
    refreshHandleVisibility();

    function applyTransform() {
      group.setAttribute("transform", `translate(${room.x}, ${room.y})`);
    }
    applyTransform();

    group.addEventListener("pointerdown", () => setActiveHandleOwner(handleOwnerKey));

    let containedFixtureIds = [];
    attachDrag(
      group,
      () => {
        // ドラッグ開始の瞬間だけ呼ばれる（部屋の移動と一緒に動かす家具を、この時点の
        // 位置関係でスナップショットしておく）
        containedFixtureIds = computeContainedFixtureIds(room);
        return { x: room.x, y: room.y };
      },
      (result) => {
        const dx = result.x - room.x;
        const dy = result.y - room.y;
        room.x = result.x;
        room.y = result.y;
        applyTransform();
        repositionAttachedFixtures(room);
        shiftFixturesByIds(containedFixtureIds, dx, dy);
        repositionRoomLabel(room.id);
      },
      (rawX, rawY) => snapRoomPosition(room, rawX, rawY),
      (clientX, clientY) => { if (onRoomClick) onRoomClick(room, clientX, clientY); }
    );

    // 各角のリサイズハンドル：部屋自体のドラッグと衝突しないようstopPropagationする。
    // 毎回「直前のスナップ済みの値」を基準に積み上げると、1歩あたりの移動量が
    // スナップ閾値未満の場合に同じグリッド線へ吸着し直され続けて動かなくなる
    // （閾値未満のドラッグが繰り返し無効化される）ため、ドラッグ開始時の元サイズ・
    // 元座標を固定基準として保持し、常にそこからの累計移動量で計算する。
    // ドラッグした角の「対角」は、その辺を動かさないことで自然に固定される。
    CORNER_DEFS.forEach((def) => {
      const handleEl = cornerHandles[def.key];
      const movesLeft = def.dx === 0; // 左辺を動かす角か（右辺=対角側は固定）
      const movesTop = def.dy === 0; // 上辺を動かす角か（下辺=対角側は固定）
      let resizing = false;
      let resizeStartWorld = null;
      let origin = null; // {x,y,width,height} ドラッグ開始時点の部屋の位置・大きさ
      let resizeContainedOrigins = {}; // fixtureId -> ドラッグ開始時点のx,y

      handleEl.addEventListener("pointerdown", (evt) => {
        resizing = true;
        handleEl.setPointerCapture(evt.pointerId);
        evt.stopPropagation();
        resizeStartWorld = screenToWorld(evt.clientX, evt.clientY);
        origin = { x: room.x, y: room.y, width: room.width, height: room.height };
        resizeContainedOrigins = computeContainedFixtureOrigins(room);
        evt.preventDefault();
      });
      handleEl.addEventListener("pointermove", (evt) => {
        if (!resizing) return;
        evt.stopPropagation();
        const world = screenToWorld(evt.clientX, evt.clientY);
        const dx = world.x - resizeStartWorld.x;
        const dy = world.y - resizeStartWorld.y;

        const MIN_ROOM_SIZE = GRID * 2;
        if (movesLeft) {
          const right = origin.x + origin.width; // 固定される対角の辺
          const snappedLeft = snapRoomEdgeX(room, origin.x + dx);
          room.x = Math.min(snappedLeft, right - MIN_ROOM_SIZE);
          room.width = right - room.x;
        } else {
          const snappedRight = snapRoomEdgeX(room, origin.x + origin.width + dx);
          room.width = Math.max(MIN_ROOM_SIZE, snappedRight - room.x);
        }
        if (movesTop) {
          const bottom = origin.y + origin.height;
          const snappedTop = snapRoomEdgeY(room, origin.y + dy);
          room.y = Math.min(snappedTop, bottom - MIN_ROOM_SIZE);
          room.height = bottom - room.y;
        } else {
          const snappedBottom = snapRoomEdgeY(room, origin.y + origin.height + dy);
          room.height = Math.max(MIN_ROOM_SIZE, snappedBottom - room.y);
        }

        applyTransform();
        fillRect.setAttribute("width", room.width);
        fillRect.setAttribute("height", room.height);
        repositionCornerHandles();
        redrawWalls();
        repositionAttachedFixtures(room);
        // tl/tr/blなど、部屋の原点(x,y)自体が動く角をドラッグした時だけ、
        // 中の家具も原点の移動量ぶんだけ一緒にずらす（brのように原点が動かない
        // リサイズでは家具はその場に留まる＝家具の位置に部屋が伸びてくる形になる）
        applyFixtureOriginShift(resizeContainedOrigins, room.x - origin.x, room.y - origin.y);
        repositionRoomLabel(room.id);
      });
      handleEl.addEventListener("pointerup", (evt) => {
        resizing = false;
        handleEl.releasePointerCapture(evt.pointerId);
        evt.stopPropagation();
        if (onDragEnd) onDragEnd();
      });
    });

    roomGroups[room.id] = group;
    layerRooms.appendChild(group);
  }

  // 部屋名・広さラベルは階段などの家具に隠れないよう、家具レイヤーより上の
  // 専用レイヤー(layerRoomLabels)に部屋とは別のワールド座標で描く。
  // 背景に半透明のピルを敷くことで、下に何が重なっても文字が読める。
  function addRoomLabelNode(room) {
    const group = svgEl("g", { class: "room-label-node" });

    const labelBg = svgEl("rect", { class: "room-label-bg", rx: 6 });
    group.appendChild(labelBg);
    const labelText = svgEl("text", { class: "room-label", "text-anchor": "middle" });
    labelText.textContent = room.label || "";
    group.appendChild(labelText);

    const tatamiBg = svgEl("rect", { class: "room-label-bg", rx: 6 });
    group.appendChild(tatamiBg);
    const tatamiText = svgEl("text", { class: "room-tatami", "text-anchor": "middle" });
    tatamiText.textContent = room.tatami || "";
    group.appendChild(tatamiText);
    if (!room.tatami) {
      tatamiBg.style.display = "none";
      tatamiText.style.display = "none";
    }

    layerRoomLabels.appendChild(group);

    function fitBgToText(text, bg) {
      try {
        const bbox = text.getBBox();
        bg.setAttribute("x", bbox.x - 6);
        bg.setAttribute("y", bbox.y - 3);
        bg.setAttribute("width", bbox.width + 12);
        bg.setAttribute("height", bbox.height + 6);
      } catch (e) {
        // 非表示状態などでgetBBoxが失敗しても致命的ではないため無視
      }
    }

    function reposition() {
      const x = room.x + room.width / 2;
      labelText.setAttribute("x", x);
      labelText.setAttribute("y", room.y + 20);
      tatamiText.setAttribute("x", x);
      tatamiText.setAttribute("y", room.y + room.height - 10);
      // getBBox()は描画確定後でないと正しい値が取れないため、次のフレームで背景を合わせる
      requestAnimationFrame(() => {
        fitBgToText(labelText, labelBg);
        if (room.tatami) fitBgToText(tatamiText, tatamiBg);
      });
    }
    reposition();

    roomLabelRepositioners[room.id] = reposition;
  }

  function repositionRoomLabel(roomId) {
    const reposition = roomLabelRepositioners[roomId];
    if (reposition) reposition();
  }

  // ===== 家具・設備アイコン =====
  // ドア・窓（壁付け種類）は「上側の壁に取り付き、部屋の内側(+y方向)へ開く」向きを
  // 基準(ローカルy=0が壁面、+yが室内側)に描く。それ以外の家具は中心(0,0)基準で描く。
  function drawFixtureIcon(type, w, h, fixture) {
    const g = svgEl("g", { class: "fixture-icon" });
    const T = Madori.FixtureType;
    function add(el) { g.appendChild(el); return el; }

    // 左右反転(scale(-1,1))された家具の中でも文字だけは鏡文字にならないよう、
    // 「位置は反転後の場所に、見た目は正しい向きのまま」描くための入れ子グループを作る。
    // (親のscale(-1,1)を子でもう一度scale(-1,1)すると図形の向きだけ元に戻り、
    //  translateした位置は反転後の場所のまま保たれる)
    function addUprightText(x, y, attrs, content) {
      const text = svgEl("text", Object.assign({ x: 0, y: 0 }, attrs));
      text.textContent = content;
      if (fixture && fixture.flipped) {
        const wrapper = svgEl("g", { transform: `translate(${x}, ${y}) scale(-1, 1)` });
        wrapper.appendChild(text);
        g.appendChild(wrapper);
      } else {
        text.setAttribute("x", x);
        text.setAttribute("y", y);
        g.appendChild(text);
      }
      return text;
    }

    // ドアの扇形(開閉軌跡)を描く共通処理。hingeXが丁番側(壁に固定されている側)、
    // oppositeXが枠の反対側。壁沿いの区間(y=0の直線)は塗りをきれいな扇形にするためだけに
    // 使い、実際に見える輪郭線には含めない＝壁の開口部をまたぐ線を描いてしまうと、
    // 見た目上「壁が閉じている」ように見えてしまい開口部と矛盾するため。
    // sweep-flagはoppositeXがhingeXよりどちら側にあるかから自動で決める
    // （手動指定すると向きを間違えやすく、実際に壁の外側に弧が出てしまう不具合があったため）
    function addDoorFan(hingeX, oppositeX, radius) {
      const sweepFlag = oppositeX >= hingeX ? 0 : 1;
      add(svgEl("path", {
        d: `M ${hingeX} 0 L ${hingeX} ${radius} A ${radius} ${radius} 0 0 ${sweepFlag} ${oppositeX} 0 Z`,
        fill: "#eef3f5",
        stroke: "none",
      }));
      add(svgEl("path", {
        d: `M ${hingeX} 0 L ${hingeX} ${radius} A ${radius} ${radius} 0 0 ${sweepFlag} ${oppositeX} 0`,
        fill: "none",
        "stroke-width": 1.5,
      }));
    }

    switch (type) {
      case T.DOOR: {
        // 開き戸：丁番は左端、右端まで振り切って開く扇形。
        addDoorFan(-w / 2, w / 2, w);
        break;
      }
      case T.SLIDING_DOOR: {
        // 引き戸：走行レール(2本線)を全幅に、戸のパネルを開口部の半分弱に描く
        add(svgEl("line", { x1: -w / 2, y1: -3, x2: w / 2, y2: -3 }));
        add(svgEl("line", { x1: -w / 2, y1: 3, x2: w / 2, y2: 3 }));
        add(svgEl("rect", { x: -w / 2, y: -5, width: w * 0.55, height: 10, fill: "#fdf6ea" }));
        break;
      }
      case T.DOUBLE_DOOR: {
        // 両開き戸：左右対称の2つの扇形が中央で組み合う
        const r = w / 2;
        addDoorFan(-w / 2, 0, r);
        addDoorFan(w / 2, 0, r);
        break;
      }
      case T.PARENT_CHILD_DOOR: {
        // 親子扉：普段使う大きい戸(親)と、車椅子等の通過時だけ開ける小さい戸(子)が
        // 並ぶ形式。それぞれ独立した扇形で、内側の境界点で組み合う。
        const mainW = w * 0.68;
        const childW = w - mainW;
        const meet = -w / 2 + mainW;
        addDoorFan(-w / 2, meet, mainW);
        addDoorFan(w / 2, meet, childW);
        break;
      }
      case T.FOLDING_DOOR: {
        // 折れ戸：中央で折れるジグザグ線
        add(svgEl("polyline", { points: `${-w / 2},0 0,${h * 0.7} ${w / 2},0`, fill: "none" }));
        add(svgEl("circle", { cx: 0, cy: h * 0.7, r: 2.5 }));
        break;
      }
      case T.OPENING: {
        // 開口部(勝手口・扉なし)：出力物には何も描かないのが正しい表現（枠線が途切れて
        // いること自体が出入口の目印になる）。ただし編集画面で本当に何も描かないと、
        // 壁に付ける前（配置直後、壁から離れた場所）は掴む場所が無く選択・移動が一切
        // できなくなってしまう。そこで画面上でだけ薄い点線の枠を出す
        // （class="fixture-editor-hint"はNON_PRINT_SELECTORSに含まれており出力時には除去される）
        add(svgEl("rect", {
          x: -w / 2, y: -h / 2, width: w, height: h,
          class: "fixture-editor-hint",
          fill: "none",
        }));
        break;
      }
      case T.WINDOW: {
        // 窓：全国共通で最も一般的な「引き違い窓」の表現＝平行な2本線
        add(svgEl("rect", { x: -w / 2, y: -h / 2, width: w, height: h, fill: "#eaf6ff", stroke: "none" }));
        add(svgEl("line", { x1: -w / 2, y1: -h * 0.22, x2: w / 2, y2: -h * 0.22, "stroke-width": 1.5 }));
        add(svgEl("line", { x1: -w / 2, y1: h * 0.22, x2: w / 2, y2: h * 0.22, "stroke-width": 1.5 }));
        break;
      }
      case T.TOILET: {
        add(svgEl("rect", { x: -w / 2, y: -h / 2, width: w, height: h * 0.28, rx: 3 }));
        add(svgEl("ellipse", { cx: 0, cy: h * 0.12, rx: w / 2.4, ry: h * 0.36 }));
        break;
      }
      case T.BATHTUB: {
        add(svgEl("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: h / 2.2, fill: "#eaf6ff" }));
        break;
      }
      case T.SINK: {
        add(svgEl("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 6 }));
        add(svgEl("ellipse", { cx: 0, cy: 0, rx: w / 3, ry: h / 4, fill: "#eaf6ff" }));
        break;
      }
      case T.KITCHEN: {
        add(svgEl("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 3 }));
        add(svgEl("rect", { x: -w / 2 + 6, y: -h / 4, width: w * 0.32, height: h / 2, fill: "#eaf6ff" }));
        add(svgEl("circle", { cx: w * 0.14, cy: 0, r: h * 0.16, fill: "none" }));
        add(svgEl("circle", { cx: w * 0.34, cy: 0, r: h * 0.16, fill: "none" }));
        break;
      }
      case T.BED: {
        add(svgEl("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 4 }));
        add(svgEl("rect", { x: -w / 2 + 6, y: -h / 2 + 6, width: w - 12, height: h * 0.16, rx: 3, fill: "#eaf6ff" }));
        break;
      }
      case T.TABLE: {
        add(svgEl("circle", { cx: 0, cy: 0, r: w / 2, fill: "#fffdf5" }));
        [0, 90, 180, 270].forEach((deg) => {
          const rad = (deg * Math.PI) / 180;
          const cx = Math.cos(rad) * (w / 2 + 8);
          const cy = Math.sin(rad) * (w / 2 + 8);
          add(svgEl("circle", { cx, cy, r: 4 }));
        });
        break;
      }
      case T.WHEELCHAIR: {
        add(svgEl("circle", { cx: -w * 0.1, cy: h * 0.15, r: h * 0.32, fill: "none", "stroke-width": 2.5 }));
        add(svgEl("circle", { cx: w * 0.32, cy: h * 0.38, r: h * 0.1, fill: "none" }));
        add(svgEl("path", { d: `M ${-w * 0.1} ${-h * 0.3} L ${-w * 0.1} ${h * 0.15} L ${w * 0.15} ${h * 0.3}`, fill: "none" }));
        break;
      }
      case T.PORTABLE_TOILET: {
        add(svgEl("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 4 }));
        add(svgEl("ellipse", { cx: 0, cy: -h * 0.1, rx: w / 3, ry: h * 0.18, fill: "#eaf6ff" }));
        break;
      }
      case T.HANDRAIL_V: {
        // 実際の住宅改修見取り図例では、手すりは片端にだけ点を打つ（両端に点は付けない）
        add(svgEl("line", { x1: 0, y1: -h / 2, x2: 0, y2: h / 2, "stroke-width": 3 }));
        add(svgEl("circle", { cx: 0, cy: -h / 2, r: 3.5 }));
        break;
      }
      case T.HANDRAIL_H: {
        add(svgEl("line", { x1: -w / 2, y1: 0, x2: w / 2, y2: 0, "stroke-width": 3 }));
        add(svgEl("circle", { cx: -w / 2, cy: 0, r: 3.5 }));
        break;
      }
      case T.HANDRAIL_L: {
        add(svgEl("line", { x1: -w / 2, y1: h / 2, x2: -w / 2, y2: -h / 2, "stroke-width": 3 }));
        add(svgEl("line", { x1: -w / 2, y1: -h / 2, x2: w / 2, y2: -h / 2, "stroke-width": 3 }));
        add(svgEl("circle", { cx: -w / 2, cy: -h / 2, r: 3.5 }));
        break;
      }
      case T.STEP: {
        add(svgEl("rect", { x: -w / 2, y: -h / 2, width: w, height: h, fill: "url(#madori-hatch)" }));
        add(svgEl("rect", { x: -w / 2, y: -h / 2, width: w, height: h, fill: "none" }));
        break;
      }
      case T.RAMP: {
        add(svgEl("polygon", {
          points: `${-w / 2},${h / 2} ${w / 2},${h / 2} ${w / 2},${-h / 2}`,
          fill: "url(#madori-hatch)",
        }));
        break;
      }
      case T.STAIRS: {
        add(svgEl("rect", { x: -w / 2, y: -h / 2, width: w, height: h, fill: "#fdf6ea" }));
        const treadCount = Math.max(3, Math.round(h / 18));
        for (let i = 1; i < treadCount; i++) {
          const ty = -h / 2 + (h / treadCount) * i;
          add(svgEl("line", { x1: -w / 2, y1: ty, x2: w / 2, y2: ty }));
        }
        add(svgEl("line", { x1: 0, y1: h / 2 - 10, x2: 0, y2: -h / 2 + 14, "stroke-width": 2 }));
        add(svgEl("polygon", { points: `0,${-h / 2 + 6} ${-6},${-h / 2 + 16} 6,${-h / 2 + 16}`, fill: "currentColor" }));
        addUprightText(w / 2 - 4, h / 2 - 6, { "text-anchor": "end", class: "fixture-mini-label" }, "階段");
        break;
      }
      case T.NORTH: {
        add(svgEl("circle", { cx: 0, cy: 0, r: w / 2, fill: "#fffdf5" }));
        add(svgEl("path", { d: `M 0 ${-h / 2 + 4} L ${w * 0.14} ${h * 0.12} L 0 0 L ${-w * 0.14} ${h * 0.12} Z`, fill: "#2f3b52" }));
        addUprightText(0, h / 2 - 3, { "text-anchor": "middle", class: "fixture-mini-label" }, "北");
        break;
      }
      case T.ARROW: {
        add(svgEl("line", { x1: -w / 2, y1: 0, x2: w / 2 - 6, y2: 0, "stroke-width": 2.5 }));
        add(svgEl("polygon", { points: `${w / 2},0 ${w / 2 - 10},-6 ${w / 2 - 10},6`, fill: "currentColor" }));
        break;
      }
      case T.CUSTOM: {
        // 家具・設備の一覧に無いもの（押入・PC台・仏壇など）を、選んだ図形＋自由な名前で表現する。
        // 名前はアイコンの中に直接表示する（他の種類のような任意の「注釈」ではなく、これ自体が主役のため）。
        const shape = (fixture && fixture.customShape) || Madori.CustomShape.RECT;
        const S = Madori.CustomShape;
        if (shape === S.CIRCLE) {
          add(svgEl("ellipse", { cx: 0, cy: 0, rx: w / 2, ry: h / 2, fill: "#fffdf5" }));
        } else if (shape === S.TRIANGLE) {
          add(svgEl("polygon", { points: `0,${-h / 2} ${w / 2},${h / 2} ${-w / 2},${h / 2}`, fill: "#fffdf5" }));
        } else if (shape === S.DIAMOND) {
          add(svgEl("polygon", { points: `0,${-h / 2} ${w / 2},0 0,${h / 2} ${-w / 2},0`, fill: "#fffdf5" }));
        } else {
          add(svgEl("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 6, fill: "#fffdf5" }));
        }
        addUprightText(0, 4, { "text-anchor": "middle", class: "fixture-mini-label custom-fixture-name" }, (fixture && fixture.label) || "？");
        break;
      }
      default:
        add(svgEl("rect", { x: -w / 2, y: -h / 2, width: w, height: h }));
    }
    return g;
  }

  function ensureHatchPattern() {
    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = svgEl("defs", {});
      svg.insertBefore(defs, svg.firstChild);
    }
    if (defs.querySelector("#madori-hatch")) return;
    const pattern = svgEl("pattern", {
      id: "madori-hatch", width: 8, height: 8, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)",
    });
    pattern.appendChild(svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 8, stroke: "#4d8fff", "stroke-width": 2 }));
    defs.appendChild(pattern);
  }

  function fixtureHitBox(fixture, wallAttachable) {
    if (wallAttachable) {
      // 壁付け種類はローカルy=0〜height方向(壁面〜室内側)に描かれるため、
      // 当たり判定もその範囲＋少し の余裕を持たせる。ただし部屋の内側へ広げすぎると
      // （特に小さい部屋で）ドアの当たり判定が部屋本体のドラッグ操作を覆ってしまうため、
      // パディングは控えめにする（見た目のアイコンとほぼ同じ範囲＋数px）。
      return { x: -fixture.width / 2 - 4, y: -6, w: fixture.width + 8, h: fixture.height + 6 };
    }
    const w = Math.max(fixture.width, MIN_HIT);
    const h = Math.max(fixture.height, MIN_HIT);
    return { x: -w / 2, y: -h / 2, w, h };
  }

  // ドア・窓はローカルy=0〜height(壁面〜室内側)基準、それ以外は中心(0,0)基準で描く
  // （drawFixtureIconの前提と揃える）。リサイズ・回転ハンドルの位置計算に使う。
  function fixtureTopLocalY(fixture, wallAttachable) {
    return wallAttachable ? 0 : -fixture.height / 2;
  }

  // 壁に取り付いたドア・窓の開口部の中心位置(offset)・座標を、現在の幅に合わせて
  // クランプし直す（部屋の移動・リサイズ時、および家具自体のリサイズ時の両方から使う）。
  function clampFixtureToWall(fixture, room) {
    const len = wallLength(room, fixture.wall.side);
    const margin = Math.min(fixture.width / 2, len / 2);
    fixture.wall.offset = Math.min(Math.max(fixture.wall.offset, margin), Math.max(len - margin, margin));
    const p = wallPointWorld(room, fixture.wall.side, fixture.wall.offset);
    fixture.x = p.x;
    fixture.y = p.y;
  }

  // 手動での自由回転の角度を15度刻みの近くで軽くスナップさせる（±4度以内）。
  // 「大体綺麗な角度」を選びやすくしつつ、90度に縛られない自由な角度も許す。
  function snapAngleSoftly(deg) {
    const nearest = Math.round(deg / 15) * 15;
    return Math.abs(deg - nearest) < 4 ? ((nearest % 360) + 360) % 360 : deg;
  }

  function addFixtureNode(fixture) {
    const wallAttachable = Madori.isWallAttachable(fixture.type);
    const group = svgEl("g", { class: `fixture-node fixture-${fixture.type}` });
    group.style.cursor = "grab";

    // クリック・ドラッグ用の透明な当たり判定（見た目には出さず、fill="transparent"で
    // ヒットテスト対象にする。fill="none"だとクリックを拾えないので注意）。
    const hitBox = fixtureHitBox(fixture, wallAttachable);
    const hitRect = svgEl("rect", {
      x: hitBox.x, y: hitBox.y, width: hitBox.w, height: hitBox.h,
      class: "fixture-hit-area",
    });
    group.appendChild(hitRect);

    let icon = drawFixtureIcon(fixture.type, fixture.width, fixture.height, fixture);
    group.appendChild(icon);

    // CUSTOM種類は名前がアイコンの中に直接描かれるため、下に重ねて表示する必要が無い
    if (fixture.label && fixture.type !== Madori.FixtureType.CUSTOM) {
      const labelY = (wallAttachable ? fixture.height : fixture.height / 2) + 14;
      const label = svgEl("text", { x: 0, y: 0, class: "fixture-label", "text-anchor": "middle" });
      label.textContent = fixture.label;
      // x=0の中央寄せなので反転しても位置は変わらないが、文字が鏡文字にならないよう
      // 反転中は入れ子のscale(-1,1)で見た目だけ元に戻す（アイコン内のaddUprightTextと同じ考え方）
      if (fixture.flipped) {
        const wrapper = svgEl("g", { transform: `translate(0, ${labelY}) scale(-1, 1)` });
        wrapper.appendChild(label);
        group.appendChild(wrapper);
      } else {
        label.setAttribute("y", labelY);
        group.appendChild(label);
      }
    }

    // リサイズハンドル（全種類に対応：階段はもちろん、便器やベッドも部屋に合わせて
    // 大きさを変えられるようにする）。壁付けのドア・窓は「開口部の幅」だけが意味を持つため
    // 従来通り1つ（壁の内側方向の角）だけ、それ以外は四隅どこからでも調整できるようにする
    // （対角のハンドルが固定されるので、部屋との位置合わせがしやすい）。
    const cornerDefs = wallAttachable
      ? [{ key: "br", cursor: "nwse-resize", dx: 1, dy: 1 }]
      : [
          { key: "tl", cursor: "nwse-resize", dx: 0, dy: 0 },
          { key: "tr", cursor: "nesw-resize", dx: 1, dy: 0 },
          { key: "bl", cursor: "nesw-resize", dx: 0, dy: 1 },
          { key: "br", cursor: "nwse-resize", dx: 1, dy: 1 },
        ];
    const resizeHandles = {};
    function handleLocalX(def) { return def.dx === 0 ? -fixture.width / 2 : fixture.width / 2; }
    function handleLocalY(def) { return fixtureTopLocalY(fixture, wallAttachable) + def.dy * fixture.height; }
    cornerDefs.forEach((def) => {
      const el = buildResizeHandle(def.cursor);
      el.setAttribute("transform", `translate(${handleLocalX(def)}, ${handleLocalY(def)})`);
      group.appendChild(el);
      resizeHandles[def.key] = el;
    });

    // このパーツが「直近で操作したもの」の時だけハンドルを見せる
    const handleOwnerKey = `fixture:${fixture.id}`;
    function refreshHandleVisibility() {
      const isActive = activeHandleOwner === handleOwnerKey;
      Object.keys(resizeHandles).forEach((key) => {
        resizeHandles[key].style.display = isActive ? "" : "none";
      });
      if (rotateHandle) rotateHandle.style.display = isActive ? "" : "none";
      group.classList.toggle("is-selected", isActive);
    }
    handleVisibilityRefreshers[handleOwnerKey] = refreshHandleVisibility;
    group.addEventListener("pointerdown", () => setActiveHandleOwner(handleOwnerKey));

    // 回転ハンドル（壁にフィット中は向きが自動で決まるため出さない。フィットしていない
    // 家具だけ、ドラッグで自由な角度に回せる小さな丸を上に出す）
    let rotateHandle = null;
    let rotateKnob = null;
    function buildRotateHandle() {
      if (rotateHandle) { group.removeChild(rotateHandle); rotateHandle = null; rotateKnob = null; }
      if (fixture.wall) { refreshHandleVisibility(); return; }
      const topY = fixtureTopLocalY(fixture, wallAttachable) - 22;
      const lineStartY = fixtureTopLocalY(fixture, wallAttachable);
      rotateHandle = svgEl("g", { class: "fixture-rotate-handle" });
      rotateHandle.appendChild(svgEl("line", { x1: 0, y1: lineStartY, x2: 0, y2: topY, class: "rotate-handle-line" }));
      rotateKnob = svgEl("circle", { cx: 0, cy: topY, r: 6, class: "rotate-handle-knob" });
      rotateHandle.appendChild(rotateKnob);
      rotateHandle.style.cursor = "grab";
      group.appendChild(rotateHandle);
      refreshHandleVisibility();

      let rotating = false;
      rotateKnob.addEventListener("pointerdown", (evt) => {
        rotating = true;
        rotateKnob.setPointerCapture(evt.pointerId);
        evt.stopPropagation();
        evt.preventDefault();
      });
      rotateKnob.addEventListener("pointermove", (evt) => {
        if (!rotating) return;
        evt.stopPropagation();
        const world = screenToWorld(evt.clientX, evt.clientY);
        const dx = world.x - fixture.x;
        const dy = world.y - fixture.y;
        let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
        deg = ((deg % 360) + 360) % 360;
        fixture.rotation = snapAngleSoftly(deg);
        applyTransform();
      });
      rotateKnob.addEventListener("pointerup", (evt) => {
        rotating = false;
        rotateKnob.releasePointerCapture(evt.pointerId);
        evt.stopPropagation();
        if (onDragEnd) onDragEnd();
      });
    }
    buildRotateHandle();

    function applyTransform() {
      const flip = fixture.flipped ? -1 : 1;
      group.setAttribute(
        "transform",
        `translate(${fixture.x}, ${fixture.y}) rotate(${fixture.rotation}) scale(${flip}, 1)`
      );
    }
    applyTransform();

    attachDrag(
      group,
      () => ({ x: fixture.x, y: fixture.y }),
      (result) => {
        const previousRoomId = fixture.wall ? fixture.wall.roomId : null;
        fixture.x = result.x;
        fixture.y = result.y;
        if (wallAttachable) {
          fixture.rotation = result.rotation;
          fixture.wall = result.wall;
        }
        applyTransform();
        if (wallAttachable) {
          const nextRoomId = fixture.wall ? fixture.wall.roomId : null;
          if (previousRoomId && previousRoomId !== nextRoomId) redrawRoomWalls(previousRoomId);
          if (nextRoomId) redrawRoomWalls(nextRoomId);
          if (previousRoomId !== nextRoomId) buildRotateHandle(); // 壁への出入りで回転ハンドルの有無が変わる
        }
      },
      (rawX, rawY) => {
        if (!wallAttachable) {
          const wallSnap = computeFurnitureWallSnap(fixture.width, fixture.height, fixture.rotation, rawX, rawY);
          return {
            x: wallSnap && wallSnap.x !== null ? wallSnap.x : snapToGridSoft(rawX),
            y: wallSnap && wallSnap.y !== null ? wallSnap.y : snapToGridSoft(rawY),
          };
        }
        const attachment = computeWallAttachment(fixture.width, rawX, rawY, WALL_SNAP_THRESHOLD);
        if (attachment) {
          const room = currentDocument.rooms.find((r) => r.id === attachment.roomId);
          const point = wallPointWorld(room, attachment.side, attachment.offset);
          return {
            x: point.x,
            y: point.y,
            rotation: Madori.WALL_SIDE_ROTATION[attachment.side],
            wall: { roomId: attachment.roomId, side: attachment.side, offset: attachment.offset },
          };
        }
        return { x: snapToGridSoft(rawX), y: snapToGridSoft(rawY), rotation: fixture.rotation, wall: null };
      },
      (clientX, clientY) => { if (onFixtureClick) onFixtureClick(fixture, clientX, clientY); }
    );

    // リサイズ後に見た目(アイコン・当たり判定・各種ハンドル位置)をまとめて更新する
    function refreshAfterResize() {
      const newIcon = drawFixtureIcon(fixture.type, fixture.width, fixture.height, fixture);
      group.replaceChild(newIcon, icon);
      icon = newIcon;
      const newHitBox = fixtureHitBox(fixture, wallAttachable);
      hitRect.setAttribute("x", newHitBox.x);
      hitRect.setAttribute("y", newHitBox.y);
      hitRect.setAttribute("width", newHitBox.w);
      hitRect.setAttribute("height", newHitBox.h);
      cornerDefs.forEach((def) => {
        const el = resizeHandles[def.key];
        el.setAttribute("transform", `translate(${handleLocalX(def)}, ${handleLocalY(def)})`);
      });
      if (rotateKnob) {
        const topY = fixtureTopLocalY(fixture, wallAttachable) - 22;
        rotateHandle.firstChild.setAttribute("y1", fixtureTopLocalY(fixture, wallAttachable));
        rotateHandle.firstChild.setAttribute("y2", topY);
        rotateKnob.setAttribute("cy", topY);
      }
    }

    cornerDefs.forEach((def) => {
      const handleEl = resizeHandles[def.key];
      const movesRight = def.dx === 1;
      const movesBottom = def.dy === 1;
      let resizing = false;
      let resizeStartWorld = null;
      let originWidth = 0;
      let originHeight = 0;
      let originCenter = null;
      let originRotationRad = 0;

      handleEl.addEventListener("pointerdown", (evt) => {
        resizing = true;
        handleEl.setPointerCapture(evt.pointerId);
        evt.stopPropagation();
        resizeStartWorld = screenToWorld(evt.clientX, evt.clientY);
        originWidth = fixture.width;
        originHeight = fixture.height;
        originCenter = { x: fixture.x, y: fixture.y };
        originRotationRad = (fixture.rotation * Math.PI) / 180;
        evt.preventDefault();
      });
      handleEl.addEventListener("pointermove", (evt) => {
        if (!resizing) return;
        evt.stopPropagation();
        const world = screenToWorld(evt.clientX, evt.clientY);
        const dx = world.x - resizeStartWorld.x;
        const dy = world.y - resizeStartWorld.y;

        if (wallAttachable) {
          // 壁付け種類は「幅(壁に沿った長さ)」だけを変える。太さ(高さ)はドアや窓の
          // 厚みを表す小さな値のため、ハンドルをドラッグした際に斜めのブレで一緒に
          // 変わってしまうと「長さだけ変えたいのに厚みも変わる」という誤動作になる。
          // 幅は壁の向き(回転)に沿った成分だけをドラッグ量から取り出して使う。
          const rot = (fixture.rotation * Math.PI) / 180;
          const alongWall = dx * Math.cos(rot) + dy * Math.sin(rot);
          fixture.width = Math.max(GRID, snapToGridOnly(originWidth + alongWall * 2));
        } else {
          // 中心基準で描くアイコンは、ドラッグした角の「対角」を世界座標上で固定するため、
          // マウスの移動量をアイコン自身の回転角の逆回転でローカル座標に変換してから
          // 幅・高さを計算し、対角が動かないよう中心(fixture.x/y)を半分だけ補正する。
          const localDx = dx * Math.cos(originRotationRad) + dy * Math.sin(originRotationRad);
          const localDy = -dx * Math.sin(originRotationRad) + dy * Math.cos(originRotationRad);

          const newWidth = Math.max(GRID, snapToGridOnly(originWidth + (movesRight ? localDx : -localDx)));
          const newHeight = Math.max(GRID, snapToGridOnly(originHeight + (movesBottom ? localDy : -localDy)));
          const widthDelta = newWidth - originWidth;
          const heightDelta = newHeight - originHeight;
          const shiftLocalX = (movesRight ? widthDelta : -widthDelta) / 2;
          const shiftLocalY = (movesBottom ? heightDelta : -heightDelta) / 2;
          const shiftWorldX = shiftLocalX * Math.cos(originRotationRad) - shiftLocalY * Math.sin(originRotationRad);
          const shiftWorldY = shiftLocalX * Math.sin(originRotationRad) + shiftLocalY * Math.cos(originRotationRad);

          fixture.width = newWidth;
          fixture.height = newHeight;
          fixture.x = originCenter.x + shiftWorldX;
          fixture.y = originCenter.y + shiftWorldY;
          applyTransform();
        }

        refreshAfterResize();

        if (fixture.wall) {
          const room = currentDocument.rooms.find((r) => r.id === fixture.wall.roomId);
          if (room) {
            clampFixtureToWall(fixture, room);
            applyTransform();
            redrawRoomWalls(room.id);
          }
        }
      });
      handleEl.addEventListener("pointerup", (evt) => {
        resizing = false;
        handleEl.releasePointerCapture(evt.pointerId);
        evt.stopPropagation();
        if (onDragEnd) onDragEnd();
      });
    });

    fixtureGroups[fixture.id] = group;
    layerFixtures.appendChild(group);
  }

  // ===== テキスト注釈 =====
  function addAnnotationNode(annotation) {
    const group = svgEl("g", { class: "annotation-node" });
    group.style.cursor = "grab";

    const bg = svgEl("rect", { class: "annotation-bg", rx: 6 });
    group.appendChild(bg);
    const text = svgEl("text", { x: 0, y: 0, class: "annotation-text", "text-anchor": "middle" });
    text.textContent = annotation.text || "";
    group.appendChild(text);

    function applyTransform() {
      group.setAttribute("transform", `translate(${annotation.x}, ${annotation.y})`);
    }
    applyTransform();

    layerAnnotations.appendChild(group);
    // getBBox()はDOMに接続されていないと使えないため、appendChildの後で背景サイズを合わせる
    requestAnimationFrame(() => {
      try {
        const bbox = text.getBBox();
        bg.setAttribute("x", bbox.x - 8);
        bg.setAttribute("y", bbox.y - 4);
        bg.setAttribute("width", bbox.width + 16);
        bg.setAttribute("height", bbox.height + 8);
      } catch (e) {
        // 非表示状態などでgetBBoxが失敗しても致命的ではないため無視
      }
    });

    attachDrag(
      group,
      () => ({ x: annotation.x, y: annotation.y }),
      (result) => { annotation.x = result.x; annotation.y = result.y; applyTransform(); },
      (rawX, rawY) => ({ x: snapToGridSoft(rawX), y: snapToGridSoft(rawY) }),
      (clientX, clientY) => { if (onAnnotationClick) onAnnotationClick(annotation, clientX, clientY); }
    );

    annotationGroups[annotation.id] = group;
  }

  // ===== 全体描画 =====
  function renderDocument(doc) {
    currentDocument = doc;
    svg.innerHTML = "";
    const defs = svgEl("defs", {});
    svg.appendChild(defs);
    viewportGroup = svgEl("g", { id: "viewport" });
    gridLayer = svgEl("g", { id: "layer-grid" });
    layerRooms = svgEl("g", { id: "layer-rooms" });
    layerFixtures = svgEl("g", { id: "layer-fixtures" });
    layerRoomLabels = svgEl("g", { id: "layer-room-labels" });
    layerAnnotations = svgEl("g", { id: "layer-annotations" });
    svg.appendChild(viewportGroup);
    viewportGroup.appendChild(gridLayer);
    viewportGroup.appendChild(layerRooms);
    viewportGroup.appendChild(layerFixtures);
    viewportGroup.appendChild(layerRoomLabels);
    viewportGroup.appendChild(layerAnnotations);
    applyViewTransform();

    ensureHatchPattern();
    renderGrid();

    Object.keys(roomGroups).forEach((k) => delete roomGroups[k]);
    Object.keys(fixtureGroups).forEach((k) => delete fixtureGroups[k]);
    Object.keys(annotationGroups).forEach((k) => delete annotationGroups[k]);
    Object.keys(roomWallRedrawers).forEach((k) => delete roomWallRedrawers[k]);
    Object.keys(roomLabelRepositioners).forEach((k) => delete roomLabelRepositioners[k]);
    Object.keys(handleVisibilityRefreshers).forEach((k) => delete handleVisibilityRefreshers[k]);

    doc.rooms.forEach(addRoomNode);
    doc.fixtures.forEach(addFixtureNode);
    doc.rooms.forEach(addRoomLabelNode);
    doc.annotations.forEach(addAnnotationNode);
    // 壁の開口部の重なりチェックは、fixtureGroupsが全部揃った後でないと反映できないため最後に行う
    doc.rooms.forEach(refreshWallConflictHighlights);
  }

  Madori.canvas = {
    init,
    getSvgElement: () => svg,
    renderDocument,
    screenToWorld,
    fitToView,
    isWorldPointVisible,
    zoomBy,
    setZoomChangeHandler,
    setRoomClickHandler,
    setFixtureClickHandler,
    setAnnotationClickHandler,
    setDragEndHandler,
    GRID,
  };
})((window.Madori = window.Madori || {}));
