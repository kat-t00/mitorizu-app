// ドキュメントの保存（ファイルダウンロード）・読込（ファイル選択）・
// 端末への自動保存（複数ケースを名前で管理）を担当する。
// genogram_web/document_store.jsと同じ設計（caseIdごとの本体＋軽い索引の2段構成）をそのまま踏襲。

(function (Madori) {
  function normalizeDocument(doc) {
    if (!doc.rooms) doc.rooms = [];
    if (!doc.fixtures) doc.fixtures = [];
    if (!doc.annotations) doc.annotations = [];
    return doc;
  }

  function saveDocument(doc, fileName) {
    const json = JSON.stringify(doc, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function loadDocumentFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          resolve(normalizeDocument(Madori.createDocument(data)));
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  // ===== 端末への自動保存（複数ケース対応）=====
  const CASE_PREFIX = "madori_case_v1_";
  const CASE_INDEX_KEY = "madori_case_index_v1";

  function makeCaseId() {
    return window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : `case_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function loadCaseIndex() {
    try {
      const raw = localStorage.getItem(CASE_INDEX_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (error) {
      return [];
    }
  }

  function saveCaseIndex(index) {
    try {
      localStorage.setItem(CASE_INDEX_KEY, JSON.stringify(index));
    } catch (error) {
      // 保存容量超過などで失敗しても操作は止めない
    }
  }

  function autosaveCase(doc) {
    if (!doc.caseId) doc.caseId = makeCaseId();
    doc.updatedAt = Date.now();
    try {
      localStorage.setItem(CASE_PREFIX + doc.caseId, JSON.stringify(doc));
    } catch (error) {
      return;
    }
    const index = loadCaseIndex();
    const entry = {
      id: doc.caseId,
      name: doc.title || "（名称未設定）",
      label: doc.caseLabel || "",
      updatedAt: doc.updatedAt,
    };
    const existingIndex = index.findIndex((e) => e.id === doc.caseId);
    if (existingIndex >= 0) index[existingIndex] = entry;
    else index.push(entry);
    saveCaseIndex(index);
  }

  function updateCaseLabel(caseId, label) {
    const doc = loadCase(caseId);
    if (!doc) return;
    doc.caseLabel = label;
    autosaveCase(doc);
  }

  function loadCase(caseId) {
    try {
      const raw = localStorage.getItem(CASE_PREFIX + caseId);
      return raw ? normalizeDocument(Madori.createDocument(JSON.parse(raw))) : null;
    } catch (error) {
      return null;
    }
  }

  function deleteCase(caseId) {
    localStorage.removeItem(CASE_PREFIX + caseId);
    saveCaseIndex(loadCaseIndex().filter((e) => e.id !== caseId));
  }

  function listCases() {
    return loadCaseIndex().slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  Madori.documentStore = {
    saveDocument,
    loadDocumentFromFile,
    makeCaseId,
    autosaveCase,
    updateCaseLabel,
    loadCase,
    deleteCase,
    listCases,
  };
})((window.Madori = window.Madori || {}));
