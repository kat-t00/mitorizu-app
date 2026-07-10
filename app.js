// アプリ全体の組み立て：起動時の初期化とツールバー・モーダルの結線。
// genogram_web/app.jsと同じ設計（refreshAll一箇所での自動保存・履歴記録、
// モーダル外側クリックでの一括クローズ）を踏襲。

(function (Madori) {
  let currentDocument = null;
  let currentFileName = null;

  // ===== 元に戻す・やり直し =====
  let undoStack = [];
  let redoStack = [];
  let lastSnapshot = null;
  let isRestoringHistory = false;
  const MAX_HISTORY = 50;

  function resetHistory() {
    undoStack = [];
    redoStack = [];
    lastSnapshot = currentDocument ? JSON.stringify(currentDocument) : null;
    updateUndoRedoButtons();
  }

  function recordHistoryIfChanged() {
    if (isRestoringHistory) return;
    const snapshot = JSON.stringify(currentDocument);
    if (lastSnapshot !== null && lastSnapshot !== snapshot) {
      undoStack.push(lastSnapshot);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack = [];
    }
    lastSnapshot = snapshot;
  }

  function restoreSnapshot(jsonText) {
    isRestoringHistory = true;
    currentDocument = Madori.createDocument(JSON.parse(jsonText));
    document.getElementById("note-textarea").value = currentDocument.note || "";
    document.getElementById("doc-title-input").value = currentDocument.title || "";
    refreshAll();
    lastSnapshot = jsonText;
    isRestoringHistory = false;
    updateUndoRedoButtons();
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(JSON.stringify(currentDocument));
    restoreSnapshot(undoStack.pop());
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(JSON.stringify(currentDocument));
    restoreSnapshot(redoStack.pop());
  }

  function updateUndoRedoButtons() {
    document.getElementById("btn-undo").disabled = undoStack.length === 0;
    document.getElementById("btn-redo").disabled = redoStack.length === 0;
  }

  function buildFreshDocument(info) {
    return Madori.createDocument({
      caseId: Madori.documentStore.makeCaseId(),
      title: info.title,
      caseLabel: info.caseLabel || "",
    });
  }

  function openNewCaseModal(onConfirm, onCancel) {
    const modal = document.getElementById("new-case-modal");
    const titleInput = document.getElementById("new-case-title");
    const labelInput = document.getElementById("new-case-label");
    const confirmButton = document.getElementById("new-case-confirm");
    const cancelButton = document.getElementById("new-case-cancel");

    titleInput.value = "";
    labelInput.value = "";
    modal.classList.remove("hidden");
    titleInput.focus();

    function cleanup() {
      modal.classList.add("hidden");
      confirmButton.removeEventListener("click", handleConfirm);
      cancelButton.removeEventListener("click", handleCancel);
    }
    function handleConfirm() {
      const title = titleInput.value.trim();
      if (!title) {
        titleInput.focus();
        return;
      }
      cleanup();
      onConfirm({ title, caseLabel: labelInput.value.trim() });
    }
    function handleCancel() {
      cleanup();
      if (onCancel) onCancel();
    }
    confirmButton.addEventListener("click", handleConfirm);
    cancelButton.addEventListener("click", handleCancel);
  }

  function loadIntoApp(doc) {
    currentDocument = doc;
    document.getElementById("note-textarea").value = doc.note || "";
    document.getElementById("doc-title-input").value = doc.title || "";
    resetHistory();
    refreshAll();
    Madori.canvas.fitToView(currentDocument);
  }

  function refreshAll() {
    recordHistoryIfChanged();
    Madori.canvas.renderDocument(currentDocument);
    Madori.documentStore.autosaveCase(currentDocument);
    renderCaseList();
    updateUndoRedoButtons();
    showSavedToast();
  }

  let saveToastHideTimer = null;
  function showSavedToast() {
    const toast = document.getElementById("save-toast");
    if (!toast) return;
    toast.classList.remove("hidden");
    requestAnimationFrame(() => toast.classList.add("visible"));
    clearTimeout(saveToastHideTimer);
    saveToastHideTimer = setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.classList.add("hidden"), 250);
    }, 1200);
  }

  function defaultFileBaseName() {
    return currentDocument.title || "住環境見取り図";
  }

  function setupModalOutsideClickClose() {
    document.querySelectorAll(".modal-overlay").forEach((overlay) => {
      overlay.addEventListener("click", (evt) => {
        if (evt.target === overlay) overlay.classList.add("hidden");
      });
    });
  }

  // ===== 部屋・家具・テキストの追加/編集/削除 =====
  function addRoomAtCenter() {
    const rect = Madori.canvas.getSvgElement().getBoundingClientRect();
    const center = Madori.canvas.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const room = Madori.createRoom({ x: Math.round(center.x - 70), y: Math.round(center.y - 50) });
    currentDocument.rooms.push(room);
    refreshAll();
  }

  function addTextAtCenter() {
    const rect = Madori.canvas.getSvgElement().getBoundingClientRect();
    const center = Madori.canvas.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const annotation = Madori.createAnnotation({ x: Math.round(center.x), y: Math.round(center.y) });
    currentDocument.annotations.push(annotation);
    refreshAll();
  }

  function computeViewCenterWorld() {
    const rect = Madori.canvas.getSvgElement().getBoundingClientRect();
    return Madori.canvas.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function placeFixture(fixture) {
    currentDocument.fixtures.push(fixture);
    refreshAll();
    if (!Madori.canvas.isWorldPointVisible(fixture.x, fixture.y, 40)) {
      Madori.canvas.fitToView(currentDocument);
    }
  }

  function addFixtureAtCenter(type) {
    // 「自由入力」は形と名前を先に聞く必要があるため、他の種類のような即時配置ではなく
    // 専用モーダルを開く
    if (type === Madori.FixtureType.CUSTOM) {
      openCustomFixtureModal();
      return;
    }
    const center = computeViewCenterWorld();
    const fixture = Madori.createFixture(type, { x: Math.round(center.x), y: Math.round(center.y) });
    placeFixture(fixture);
  }

  function openCustomFixtureModal() {
    const modal = document.getElementById("custom-fixture-modal");
    const nameInput = document.getElementById("custom-fixture-name");
    nameInput.value = "";
    document.querySelector('input[name="custom-fixture-shape"][value="rect"]').checked = true;
    modal.classList.remove("hidden");
    nameInput.focus();

    function cleanup() {
      modal.classList.add("hidden");
      confirmBtn.removeEventListener("click", handleConfirm);
      cancelBtn.removeEventListener("click", handleCancel);
    }
    function handleConfirm() {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return; // 名前は必須（アイコンの中に表示する主役の情報なので空のままは進ませない）
      }
      const shape = document.querySelector('input[name="custom-fixture-shape"]:checked').value;
      cleanup();
      const center = computeViewCenterWorld();
      const fixture = Madori.createFixture(Madori.FixtureType.CUSTOM, {
        x: Math.round(center.x),
        y: Math.round(center.y),
        customShape: shape,
        label: name,
      });
      placeFixture(fixture);
    }
    function handleCancel() {
      cleanup();
    }
    const confirmBtn = document.getElementById("custom-fixture-confirm");
    const cancelBtn = document.getElementById("custom-fixture-cancel");
    confirmBtn.addEventListener("click", handleConfirm);
    cancelBtn.addEventListener("click", handleCancel);
  }

  function setupCanvasHandlers() {
    Madori.canvas.setRoomClickHandler((room, clientX, clientY) => {
      Madori.forms.openRoomPopup(room, clientX, clientY, {
        onChange: (patch) => {
          Object.assign(room, patch);
          Madori.canvas.renderDocument(currentDocument);
          Madori.documentStore.autosaveCase(currentDocument);
        },
        // 入力欄からフォーカスが外れた時に1回だけ呼ばれる。入力中の1文字ごとではなく
        // 編集ひとまとまりを1つのUndoステップとして記録したいのでここでrefreshAllを呼ぶ
        // （refreshAll内のrecordHistoryIfChangedが、フォーカスが当たった時点の状態との
        // 差分をまとめて1件だけ履歴に積む）
        onCommit: () => { refreshAll(); },
        onDuplicate: () => {
          currentDocument.rooms.push(Madori.duplicateRoom(room));
          refreshAll();
        },
        onDelete: () => {
          currentDocument.rooms = currentDocument.rooms.filter((r) => r.id !== room.id);
          // この部屋の壁に付いていたドア・窓は、壁の無い浮いた状態にしない方が分かりやすいため
          // 自由配置に戻す（位置・向きはそのまま、壁への追従だけ解除する）
          currentDocument.fixtures.forEach((f) => {
            if (f.wall && f.wall.roomId === room.id) f.wall = null;
          });
          refreshAll();
        },
      });
    });

    Madori.canvas.setFixtureClickHandler((fixture, clientX, clientY) => {
      Madori.forms.openFixturePopup(fixture, clientX, clientY, {
        onRotate: () => {
          // 壁にフィット中の場合、回転ボタンを押した時点で壁から外し自由回転にする
          // （フィットしたままだと次の再描画で壁の向きに回転が上書きされてしまうため）
          fixture.wall = null;
          fixture.rotation = (fixture.rotation + 90) % 360;
          refreshAll();
        },
        onFlip: () => {
          fixture.flipped = !fixture.flipped;
          refreshAll();
        },
        onLabelChange: (label) => {
          fixture.label = label;
          Madori.canvas.renderDocument(currentDocument);
          Madori.documentStore.autosaveCase(currentDocument);
        },
        onCommit: () => { refreshAll(); },
        onDuplicate: () => {
          currentDocument.fixtures.push(Madori.duplicateFixture(fixture));
          refreshAll();
        },
        onDelete: () => {
          currentDocument.fixtures = currentDocument.fixtures.filter((f) => f.id !== fixture.id);
          refreshAll();
        },
      });
    });

    Madori.canvas.setAnnotationClickHandler((annotation, clientX, clientY) => {
      Madori.forms.openAnnotationPopup(annotation, clientX, clientY, {
        onTextChange: (text) => {
          annotation.text = text;
          Madori.canvas.renderDocument(currentDocument);
          Madori.documentStore.autosaveCase(currentDocument);
        },
        onCommit: () => { refreshAll(); },
        onDelete: () => {
          currentDocument.annotations = currentDocument.annotations.filter((a) => a.id !== annotation.id);
          refreshAll();
        },
      });
    });

    // ドラッグ（移動・リサイズ・回転ハンドル操作）の終了時にもrefreshAllを呼び、
    // Undo/Redoの対象にする（以前は自動保存だけで、ドラッグ操作はUndoで戻せなかった）
    Madori.canvas.setDragEndHandler(() => {
      refreshAll();
    });

    Madori.canvas.setZoomChangeHandler((percent) => {
      document.getElementById("zoom-level").textContent = `${percent}%`;
    });
  }

  function setupToolbar() {
    document.getElementById("btn-new").addEventListener("click", () => {
      openNewCaseModal((info) => {
        loadIntoApp(buildFreshDocument(info));
        currentFileName = null;
      });
    });

    document.getElementById("btn-open").addEventListener("click", () => {
      document.getElementById("file-input").click();
    });

    document.getElementById("file-input").addEventListener("change", (evt) => {
      const file = evt.target.files[0];
      if (!file) return;
      Madori.documentStore
        .loadDocumentFromFile(file)
        .then((doc) => {
          if (!doc.caseId) doc.caseId = Madori.documentStore.makeCaseId();
          loadIntoApp(doc);
          currentFileName = file.name;
        })
        .catch(() => alert("ファイルを読み込めませんでした。"))
        .finally(() => {
          evt.target.value = "";
        });
    });

    document.getElementById("btn-save-file").addEventListener("click", () => {
      const suggested = currentFileName || `${defaultFileBaseName()}_見取り図.json`;
      const fileName = window.prompt("保存するファイル名を入力してください", suggested);
      if (!fileName) return;
      currentFileName = fileName;
      Madori.documentStore.saveDocument(currentDocument, fileName);
    });

    document.getElementById("btn-add-room").addEventListener("click", addRoomAtCenter);
    document.getElementById("btn-add-text").addEventListener("click", addTextAtCenter);
    document.getElementById("btn-fit-view").addEventListener("click", () => Madori.canvas.fitToView(currentDocument));
    document.getElementById("btn-zoom-in").addEventListener("click", () => Madori.canvas.zoomBy(1.2));
    document.getElementById("btn-zoom-out").addEventListener("click", () => Madori.canvas.zoomBy(1 / 1.2));
    document.getElementById("btn-undo").addEventListener("click", undo);
    document.getElementById("btn-redo").addEventListener("click", redo);

    document.getElementById("doc-title-input").addEventListener("input", (evt) => {
      currentDocument.title = evt.target.value;
      Madori.documentStore.autosaveCase(currentDocument);
      renderCaseList();
    });
    document.getElementById("note-textarea").addEventListener("input", (evt) => {
      currentDocument.note = evt.target.value;
      Madori.documentStore.autosaveCase(currentDocument);
    });

    document.getElementById("btn-export-png").addEventListener("click", () => openExportOptions("png"));
    document.getElementById("btn-export-pdf").addEventListener("click", () => openExportOptions("pdf"));

    document.getElementById("btn-usage-guide").addEventListener("click", () => {
      document.getElementById("usage-guide-modal").classList.remove("hidden");
    });
    document.getElementById("usage-guide-close").addEventListener("click", () => {
      document.getElementById("usage-guide-modal").classList.add("hidden");
    });

    document.getElementById("btn-case-list").addEventListener("click", () => {
      renderCaseList();
      document.getElementById("case-list-modal").classList.remove("hidden");
    });
    document.getElementById("case-list-close").addEventListener("click", () => {
      document.getElementById("case-list-modal").classList.add("hidden");
    });
  }

  function renderCaseList() {
    const container = document.getElementById("case-list-container");
    Madori.forms.renderCaseList(container, Madori.documentStore.listCases(), {
      onOpen: (caseId) => {
        const doc = Madori.documentStore.loadCase(caseId);
        if (doc) {
          loadIntoApp(doc);
          currentFileName = null;
        }
        document.getElementById("case-list-modal").classList.add("hidden");
      },
      onDelete: (caseId) => {
        Madori.documentStore.deleteCase(caseId);
        if (currentDocument && currentDocument.caseId === caseId) {
          startBrandNewCase();
        }
        renderCaseList();
      },
      onRelabel: (caseId, label) => {
        Madori.documentStore.updateCaseLabel(caseId, label);
        renderCaseList();
      },
    });
  }

  function startBrandNewCase() {
    openNewCaseModal(
      (info) => {
        loadIntoApp(buildFreshDocument(info));
        currentFileName = null;
      },
      () => {
        loadIntoApp(buildFreshDocument({ title: "無題の見取り図" }));
      }
    );
  }

  // ===== 出力オプション =====
  let pendingExportType = null;

  function openExportOptions(type) {
    pendingExportType = type;
    document.getElementById("export-options-title").textContent = type === "png" ? "🖼 画像出力" : "📄 PDF出力";
    document.getElementById("export-pdf-only-options").classList.toggle("hidden", type !== "pdf");
    document.getElementById("export-creator-name").value = currentDocument.creatorName || "";
    document.getElementById("export-transparent").checked = false;
    document.getElementById("export-transparent-floor").checked = false;
    document.getElementById("export-orientation-auto").checked = true;
    document.getElementById("export-options-modal").classList.remove("hidden");
  }

  function setupExportOptionsModal() {
    document.getElementById("export-options-cancel").addEventListener("click", () => {
      document.getElementById("export-options-modal").classList.add("hidden");
    });
    document.getElementById("export-options-close").addEventListener("click", () => {
      document.getElementById("export-options-modal").classList.add("hidden");
    });

    document.getElementById("export-options-confirm").addEventListener("click", () => {
      const options = {
        transparent: document.getElementById("export-transparent").checked,
        transparentFloor: document.getElementById("export-transparent-floor").checked,
      };
      if (pendingExportType === "png") {
        Madori.exporter.exportToPng(Madori.canvas.getSvgElement(), `${defaultFileBaseName()}_見取り図.png`, options);
      } else if (pendingExportType === "pdf") {
        currentDocument.creatorName = document.getElementById("export-creator-name").value.trim();
        Madori.documentStore.autosaveCase(currentDocument);
        options.creatorName = currentDocument.creatorName;
        options.includeLegend = document.getElementById("export-include-legend").checked;
        options.orientation = document.querySelector('input[name="export-orientation"]:checked').value;
        Madori.exporter.exportToPdf(
          Madori.canvas.getSvgElement(),
          `${defaultFileBaseName()} 住環境見取り図`,
          currentDocument.note,
          options
        );
      }
      document.getElementById("export-options-modal").classList.add("hidden");
    });
  }

  function setupKeyboardShortcuts() {
    window.addEventListener("keydown", (evt) => {
      const isMeta = evt.ctrlKey || evt.metaKey;
      if (!isMeta) return;
      if (evt.key.toLowerCase() === "z" && !evt.shiftKey) {
        evt.preventDefault();
        undo();
      } else if (evt.key.toLowerCase() === "z" && evt.shiftKey) {
        evt.preventDefault();
        redo();
      }
    });
  }

  function init() {
    Madori.canvas.init(document.getElementById("canvas"));
    Madori.forms.renderPalette(document.getElementById("fixture-palette"), addFixtureAtCenter);
    setupCanvasHandlers();
    setupToolbar();
    setupExportOptionsModal();
    setupModalOutsideClickClose();
    setupKeyboardShortcuts();

    let restored = null;
    const cases = Madori.documentStore.listCases();
    if (cases.length > 0) {
      restored = Madori.documentStore.loadCase(cases[0].id);
    }
    if (restored) {
      loadIntoApp(restored);
    } else {
      startBrandNewCase();
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})((window.Madori = window.Madori || {}));
