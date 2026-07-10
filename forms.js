// 家具パレットの描画、部屋・家具・テキスト注釈のその場編集ポップアップ、
// 保存データ一覧の描画を担当する。（genogram_web/forms.jsのポップアップ方式を踏襲）

(function (Madori) {
  let activePopup = null; // { el, targetKind, targetId }

  function closePopup() {
    if (activePopup) {
      activePopup.el.remove();
      document.getElementById("edit-panel-container").classList.remove("is-open");
      activePopup = null;
    }
  }

  // 編集パネル（PCでは右サイドパネル、スマホでは下のボトムシート）に中身を差し込む。
  // 要素の座標とは無関係な固定位置なので、家具を密集させて配置していても
  // 編集中の要素自体が隠れることがない。
  function mountPopup(el) {
    const container = document.getElementById("edit-panel-container");
    container.innerHTML = "";
    container.appendChild(el);
    container.classList.add("is-open");
  }

  // ボタンを横並びの1行にまとめる（回転/反転、複製/削除など、関連する2つの
  // ボタンを並べてパネルの縦の高さを詰めるため）
  function makeButtonRow(...buttons) {
    const row = document.createElement("div");
    row.className = "popup-button-row";
    buttons.forEach((btn) => row.appendChild(btn));
    return row;
  }

  function makePopupShell(title) {
    const el = document.createElement("div");
    el.className = "edit-popup";
    const header = document.createElement("div");
    header.className = "edit-popup-header";
    const h = document.createElement("strong");
    h.textContent = title;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "popup-close-x";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", closePopup);
    header.appendChild(h);
    header.appendChild(closeBtn);
    el.appendChild(header);
    return el;
  }

  function isSameTarget(kind, id) {
    return !!activePopup && activePopup.targetKind === kind && activePopup.targetId === id;
  }

  // ===== 部屋の編集ポップアップ =====
  function openRoomPopup(room, clientX, clientY, callbacks) {
    if (isSameTarget("room", room.id)) { closePopup(); return; }
    closePopup();
    const el = makePopupShell("部屋を編集");

    const labelRow = document.createElement("label");
    labelRow.textContent = "部屋の名前";
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.value = room.label || "";
    labelInput.addEventListener("input", () => callbacks.onChange({ label: labelInput.value }));
    // inputは1文字ごとの即時反映用、changeはフォーカスが外れた時に1回だけ発火する。
    // 編集ひとまとまりを1つのUndoステップにするため、履歴の記録はchange側でまとめて行う。
    labelInput.addEventListener("change", () => callbacks.onCommit());
    labelRow.appendChild(labelInput);
    el.appendChild(labelRow);

    const tatamiRow = document.createElement("label");
    tatamiRow.textContent = "広さ・メモ（任意、例：6帖）";
    const tatamiInput = document.createElement("input");
    tatamiInput.type = "text";
    tatamiInput.value = room.tatami || "";
    tatamiInput.addEventListener("input", () => callbacks.onChange({ tatami: tatamiInput.value }));
    tatamiInput.addEventListener("change", () => callbacks.onCommit());
    tatamiRow.appendChild(tatamiInput);
    el.appendChild(tatamiRow);

    const duplicateBtn = document.createElement("button");
    duplicateBtn.type = "button";
    duplicateBtn.className = "popup-action-button";
    duplicateBtn.textContent = "📋 複製";
    duplicateBtn.addEventListener("click", () => {
      callbacks.onDuplicate();
      closePopup();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "popup-delete-button";
    deleteBtn.textContent = "🗑 削除";
    deleteBtn.addEventListener("click", () => {
      if (!window.confirm(`「${room.label || "この部屋"}」を削除しますか？`)) return;
      callbacks.onDelete();
      closePopup();
    });
    el.appendChild(makeButtonRow(duplicateBtn, deleteBtn));

    mountPopup(el);
    activePopup = { el, targetKind: "room", targetId: room.id };
  }

  // ===== 家具・設備の編集ポップアップ =====
  function openFixturePopup(fixture, clientX, clientY, callbacks) {
    if (isSameTarget("fixture", fixture.id)) { closePopup(); return; }
    closePopup();
    const entry = Madori.findCatalogEntry(fixture.type);
    const isCustom = fixture.type === Madori.FixtureType.CUSTOM;
    // 自由入力の家具は、汎用の「✏️ 自由入力」という見出しより、自分で付けた名前を
    // 見出しに出した方が分かりやすい
    const el = makePopupShell(isCustom ? fixture.label || entry.label : entry.label);

    if (fixture.wall) {
      // 壁に自動フィットしている間は向きが壁に合わせて自動で決まるが、90度回転ボタンは
      // ここでも押せるようにする（押すと壁から自動的に外れて回転する）。反転は丁番側の
      // 左右を変えるだけで壁への取り付き方には影響しないため、壁フィット中でも使える。
      const wallHint = document.createElement("p");
      wallHint.className = "popup-hint-text";
      wallHint.textContent = "壁にフィットしています（向きは自動）。90度回転すると壁から外れて自由に回転できます。";
      el.appendChild(wallHint);
    }
    const rotateBtn = document.createElement("button");
    rotateBtn.type = "button";
    rotateBtn.className = "popup-action-button";
    rotateBtn.title = "90度回転";
    rotateBtn.textContent = "↻ 回転";
    rotateBtn.addEventListener("click", () => callbacks.onRotate());

    const flipBtn = document.createElement("button");
    flipBtn.type = "button";
    flipBtn.className = "popup-action-button";
    flipBtn.title = "左右反転";
    flipBtn.textContent = "↔ 反転";
    flipBtn.addEventListener("click", () => callbacks.onFlip());
    el.appendChild(makeButtonRow(rotateBtn, flipBtn));

    const labelRow = document.createElement("label");
    labelRow.textContent = isCustom ? "名前（アイコンに表示されます）" : "注釈（任意、例：高さ75cm）";
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.value = fixture.label || "";
    labelInput.addEventListener("input", () => callbacks.onLabelChange(labelInput.value));
    labelInput.addEventListener("change", () => callbacks.onCommit());
    labelRow.appendChild(labelInput);
    el.appendChild(labelRow);

    const duplicateBtn = document.createElement("button");
    duplicateBtn.type = "button";
    duplicateBtn.className = "popup-action-button";
    duplicateBtn.textContent = "📋 複製";
    duplicateBtn.addEventListener("click", () => {
      callbacks.onDuplicate();
      closePopup();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "popup-delete-button";
    deleteBtn.textContent = "🗑 削除";
    deleteBtn.addEventListener("click", () => {
      if (!window.confirm(`「${entry.label}」を削除しますか？`)) return;
      callbacks.onDelete();
      closePopup();
    });
    el.appendChild(makeButtonRow(duplicateBtn, deleteBtn));

    mountPopup(el);
    activePopup = { el, targetKind: "fixture", targetId: fixture.id };
  }

  // ===== テキスト注釈の編集ポップアップ =====
  function openAnnotationPopup(annotation, clientX, clientY, callbacks) {
    if (isSameTarget("annotation", annotation.id)) { closePopup(); return; }
    closePopup();
    const el = makePopupShell("テキストを編集");

    const textArea = document.createElement("textarea");
    textArea.rows = 3;
    textArea.value = annotation.text || "";
    textArea.addEventListener("input", () => callbacks.onTextChange(textArea.value));
    textArea.addEventListener("change", () => callbacks.onCommit());
    el.appendChild(textArea);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "popup-delete-button";
    deleteBtn.textContent = "🗑 削除";
    deleteBtn.addEventListener("click", () => {
      if (!window.confirm("このテキストを削除しますか？")) return;
      callbacks.onDelete();
      closePopup();
    });
    el.appendChild(deleteBtn);

    mountPopup(el);
    activePopup = { el, targetKind: "annotation", targetId: annotation.id };
    textArea.focus();
  }

  // ===== 家具パレット =====
  function renderPalette(container, onAdd) {
    container.innerHTML = "";
    Madori.FIXTURE_CATALOG.forEach((entry) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "palette-button";
      btn.textContent = entry.label;
      btn.addEventListener("click", () => onAdd(entry.type));
      container.appendChild(btn);
    });
  }

  // ===== 保存データ一覧 =====
  function renderCaseList(container, cases, callbacks) {
    container.innerHTML = "";
    if (cases.length === 0) {
      const empty = document.createElement("p");
      empty.className = "case-list-empty";
      empty.textContent = "保存データはまだありません。";
      container.appendChild(empty);
      return;
    }
    cases.forEach((c) => {
      const row = document.createElement("div");
      row.className = "case-list-row";

      const info = document.createElement("div");
      info.className = "case-list-info";
      const name = document.createElement("div");
      name.className = "case-list-name";
      name.textContent = c.name;
      const meta = document.createElement("div");
      meta.className = "case-list-meta";
      const dateLabel = new Date(c.updatedAt).toLocaleString("ja-JP");
      meta.textContent = c.label ? `${c.label}｜${dateLabel}更新` : `${dateLabel}更新`;
      info.appendChild(name);
      info.appendChild(meta);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "case-list-actions";

      const relabelBtn = document.createElement("button");
      relabelBtn.type = "button";
      relabelBtn.className = "tool-button-small";
      relabelBtn.textContent = "✏️";
      relabelBtn.title = "メモを編集";
      relabelBtn.addEventListener("click", () => {
        const next = window.prompt("メモを入力してください（例：研修用）", c.label || "");
        if (next !== null) callbacks.onRelabel(c.id, next);
      });
      actions.appendChild(relabelBtn);

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "tool-button-small";
      openBtn.textContent = "開く";
      openBtn.addEventListener("click", () => callbacks.onOpen(c.id));
      actions.appendChild(openBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "tool-button-small tool-button-danger";
      deleteBtn.textContent = "🗑";
      deleteBtn.addEventListener("click", () => {
        if (window.confirm(`「${c.name}」を削除しますか？この操作は取り消せません。`)) {
          callbacks.onDelete(c.id);
        }
      });
      actions.appendChild(deleteBtn);

      row.appendChild(actions);
      container.appendChild(row);
    });
  }

  document.addEventListener(
    "pointerdown",
    (evt) => {
      if (!activePopup) return;
      if (activePopup.el.contains(evt.target)) return;
      // 図形自身のクリックは各ノードのpointerdown/upで処理されるため、ここでは閉じない
      if (evt.target.closest && evt.target.closest(".room-node, .fixture-node, .annotation-node")) return;
      closePopup();
    },
    true
  );

  Madori.forms = {
    closePopup,
    openRoomPopup,
    openFixturePopup,
    openAnnotationPopup,
    renderPalette,
    renderCaseList,
  };
})((window.Madori = window.Madori || {}));
