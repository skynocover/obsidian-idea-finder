# Idea Finder 重構計畫

## 概述

移除不必要的功能，簡化插件架構，統一使用 chunk-based embeddings。

---

## Phase 1: 修正 Folder Filtering (Bug Fix + 簡化)

**目標**: 修正根目錄篩選問題，並移除 include 模式只保留 exclude

### 任務清單

- [x] **1.1 修改 path.ts - 修正根目錄篩選**
  - 修正 `shouldFilterPath()` 對根目錄 `/` 的處理
  - 當 folder 為 `/` 或空字串時，應匹配根目錄檔案（不含 `/` 的路徑）

- [x] **1.2 修改 path.ts - 移除 include 模式**
  - `shouldFilterPath()` 簡化邏輯，只處理 exclude 模式
  - 移除 include mode 相關判斷

- [x] **1.3 修改 settings.ts - 簡化 FolderFilterSettings**
  - 移除 `FolderFilterSettings` 中的 `mode` 屬性
  - 修改為 `interface FolderFilterSettings { folders: string[] }`
  - 修改 `DEFAULT_SETTINGS.folderFilter` 移除 mode
  - 移除 "Filter Mode" dropdown UI (第260-272行)
  - 更新 Folders 設定的 description 文字

### 測試

- [x] **1.4 編譯測試**
  - 執行 `npm run build` 確保無編譯錯誤

- [x] **1.5 功能測試**
  - [x] 設定 exclude `/`，確認根目錄檔案被排除
  - [x] 設定 exclude `folder`，確認該資料夾被排除
  - [x] 確認 Settings UI 沒有 Filter Mode dropdown

---

## Phase 2: 移除 Minimum Chunk Length 設定

**目標**: 不管 chunk 長度，只管依 heading 分割

### 任務清單

- [x] **2.1 修改 MarkdownParser.ts**
  - 移除 `ChunkingOptions` 中的 `minChunkLength` 屬性
  - 移除 `DEFAULT_CHUNKING_OPTIONS` 中的 `minChunkLength: 50`
  - 移除 `parseChunks()` 中的 minimum length 檢查:
    - 第287行: `if (chunkContent.length >= this.chunkingOptions.minChunkLength)`
    - 第316行: `if (chunkContent.length >= this.chunkingOptions.minChunkLength)`

- [x] **2.2 修改 settings.ts**
  - 移除 `DEFAULT_CHUNKING_OPTIONS` 中的 `minChunkLength`
  - 移除 "Minimum Chunk Length" 設定 UI (第337-355行)

### 測試

- [x] **2.3 編譯測試**
  - 執行 `npm run build` 確保無編譯錯誤

- [x] **2.4 功能測試**
  - [x] 確認 Settings UI 沒有 Minimum Chunk Length 設定
  - [x] 建立短內容的 heading section，確認仍被分割成 chunk
  - [x] Rebuild index，確認 chunks 正確產生

---

## Phase 3: 移除 Auto-Maintain Embeddings 功能

**目標**: 完全移除自動維護 embeddings 的功能，改為純手動模式

### 任務清單

- [x] **3.1 刪除 EmbeddingMaintenanceService**
  - 刪除檔案: `src/services/EmbeddingMaintenanceService.ts`

- [x] **3.2 從 main.ts 移除相關引用**
  - 移除 `import { EmbeddingMaintenanceService }`
  - 移除 `embeddingMaintenanceService` 屬性宣告
  - 移除 `EmbeddingMaintenanceService` 初始化 (第183-198行)
  - 移除 `embeddingMaintenanceService.start()` (第204行)
  - 移除 `onComplete` callback 中的 `this.embeddingMaintenanceService?.checkForStaleEmbeddings()` (第123行)
  - 移除 `onFileIndexed` callback 中的 `this.embeddingMaintenanceService?.notifyFileModified()` (第138行)
  - 移除 `onunload()` 中的 `embeddingMaintenanceService.stop()` (第439-441行)

- [x] **3.3 從 settings.ts 移除相關設定**
  - 移除 `IdeaFinderSettings` 中的 `autoMaintainEmbeddings` 屬性
  - 移除 `DEFAULT_SETTINGS` 中的 `autoMaintainEmbeddings: true`
  - 移除 Settings UI 中的 "Auto-maintain Embeddings" toggle (第170-183行)
  - 移除 maintenance status display (第185-194行)

### 測試

- [x] **3.4 編譯測試**
  - 執行 `npm run build` 確保無編譯錯誤

- [x] **3.5 功能測試**
  - [x] 確認 Settings UI 沒有 Auto-maintain toggle
  - [x] 修改一個已有 embedding 的檔案，確認不會自動觸發 embedding 更新
  - [x] 確認手動 Generate Embeddings 仍然正常運作

---

## Phase 4: 移除 Note-Level Embeddings 功能

**目標**: 統一使用 chunk embeddings，移除所有 note-level embedding 邏輯

### 任務清單

- [x] **4.1 修改 VectorRepository.ts**
  - 移除所有 Note-level embeddings 相關方法:
    - `upsertNoteEmbedding()`
    - `getNoteEmbedding()`
    - `getAllNoteEmbeddingsWithNotes()`
    - `getNotesNeedingEmbedding()`
    - `getNoteEmbeddingCounts()` (重新實作為統計 notes with chunk embeddings)
    - `deleteNoteEmbedding()`
    - `deleteNoteEmbeddings()`
    - `hasAnyNoteEmbeddings()`
  - 修改 `hasAnyEmbeddings()` 只檢查 chunk embeddings
  - 修改 `getEmbeddingCounts()` 只返回 chunk counts

- [x] **4.2 修改 EmbeddingService.ts**
  - 移除 `generateAll()` 方法 (note-level embedding generation)
  - 將 `generateChunkEmbeddings()` 改名為 `generateAll()`

- [x] **4.3 修改 VectorService.ts**
  - 移除 `searchByQuery()` (note-level search)
  - 移除舊的 `getSimilarNotes()` (基於 note embedding)
  - 移除 `hasEmbedding()` (檢查 note embedding)
  - 移除 `getStats()` (返回 note stats)
  - 修改 `smartSearch()` → 重命名為 `search()`，直接使用 chunk search
  - **新增**: `getSimilarChunks(noteId)` - 基於當前 note 的所有 chunks 找相似 chunks
    - 取得該 note 的所有 chunk embeddings
    - 對每個 chunk 找相似的其他 note 的 chunks
    - 聚合結果，取每個 chunk 的最高相似度
    - 排除自己，返回排序後的結果
  - **新增**: `hasEmbeddings(noteId)` - 檢查該 note 是否有任何 chunk embeddings

- [x] **4.4 修改 SimilarNotesView.ts**
  - 修改 `vectorService.hasEmbedding()` → `vectorService.hasEmbeddings()`
  - 使用新的 chunk-based `getSimilarChunks()`

- [x] **4.5 修改 SearchModal.ts**
  - 更新 `smartSearch` → `search` 的呼叫

- [x] **4.6 修改 main.ts**
  - `generate-embeddings` command 已呼叫 `generateAll()`（現在是 chunk embeddings）
  - SimilarNotesView 的 `onGenerateEmbeddings` callback 確認呼叫正確

- [x] **4.7 修改 types.ts**
  - 移除 `Embedding` interface
  - 移除 `NoteWithEmbedding` interface

- [x] **4.8 修改 sql-types.ts**
  - 移除 `EmbeddingRow` type
  - 移除 `NoteWithEmbeddingRow` type

- [x] **4.9 修改 IndexerService.ts**
  - 移除 `removeFile()` 中的 `this.vectorRepo.deleteNoteEmbedding(note.id)`
  - 移除 `cleanupDeletedFiles()` 中的 `this.vectorRepo.deleteNoteEmbeddings(noteIdsToDelete)`

### 測試

- [x] **4.10 編譯測試**
  - 執行 `npm run build` 確保無編譯錯誤

- [x] **4.11 功能測試**
  - [x] Generate Embeddings 產生 chunk embeddings
  - [x] Search 功能正常 (keyword + semantic hybrid)
  - [x] Similar Notes 顯示基於 chunk 的相似筆記
  - [x] 刪除檔案後，相關 chunk embeddings 被清理

---

## Phase 5: UI 清理與 Pending 提示

**目標**: 清理 UI，確保正確顯示 pending embeddings 提示

### 任務清單

- [x] **5.1 修改 settings.ts - 移除 Indexed Notes 顯示**
  - 移除 `renderStatus()` 中的 "Indexed Notes" Setting

- [x] **5.2 修改 settings.ts - 簡化 Embeddings 顯示**
  - 移除 "Note Embeddings" 顯示
  - 將 "Chunk Embeddings" 改名為 "Embeddings"
  - 移除 "Generate Note Embeddings" 按鈕
  - 將 "Generate Chunk Embeddings" 按鈕改名為 "Generate Embeddings"

- [x] **5.3 確認 SimilarNotesView.ts 的 pending 提示**
  - 確認 `updateStatus()` 正確顯示 pending chunk embeddings 數量
  - 確認 Generate 按鈕呼叫正確的 generation 方法

### 測試

- [x] **5.4 編譯測試**
  - 執行 `npm run build` 確保無編譯錯誤

- [x] **5.5 功能測試**
  - [x] Settings 只顯示 "Embeddings" 狀態（不顯示 Indexed Notes）
  - [x] Settings 只有一個 "Generate Embeddings" 按鈕
  - [x] Similar Notes panel 顯示正確的 pending 數量
  - [x] 新增檔案後，pending 數量增加

---

## Phase 6: 最終清理與文件更新

**目標**: 清理程式碼，更新文件

### 任務清單

- [x] **6.1 清理程式碼**
  - 移除未使用的 imports
  - 移除未使用的 types
  - 檢查是否有遺留的 note embedding 相關程式碼
  - 修正 IndexerService.ts 和 FileWatcherService.ts 中的 default options

- [x] **6.2 更新 CLAUDE.md**
  - 移除 `embeddings` table 相關說明（或標記為 deprecated）
  - 更新 Settings 說明（移除 autoMaintainEmbeddings、minChunkLength、folderFilter.mode）
  - 更新 Service 說明（移除 EmbeddingMaintenanceService）
  - 更新 VectorService 說明（chunk-based search/similar）

- [x] **6.3 最終驗證**
  - 執行 `npm run build` 確保無編譯錯誤
  - 完整流程測試：Index → Generate Embeddings → Search → Similar Notes

---

## 受影響檔案清單

| 檔案路徑 | Phase | 變更類型 |
|---------|-------|---------|
| `src/utils/path.ts` | 1 | 修改 |
| `src/settings.ts` | 1,2,3,5 | 大幅修改 |
| `src/utils/MarkdownParser.ts` | 2 | 修改 |
| `src/services/EmbeddingMaintenanceService.ts` | 3 | 刪除 |
| `src/main.ts` | 3,4 | 修改 |
| `src/database/repositories/VectorRepository.ts` | 4 | 大幅修改 |
| `src/services/EmbeddingService.ts` | 4 | 修改 |
| `src/services/VectorService.ts` | 4 | 大幅修改 |
| `src/ui/SimilarNotesView.ts` | 4,5 | 修改 |
| `src/ui/SearchModal.ts` | 4 | 小幅修改 |
| `src/types.ts` | 4 | 修改 |
| `src/database/sql-types.ts` | 4 | 修改 |
| `src/services/IndexerService.ts` | 4 | 小幅修改 |
| `CLAUDE.md` | 6 | 更新 |

---

## 執行順序圖

```
Phase 1 (Folder Filter)     獨立 bug fix → 測試
        ↓
Phase 2 (Min Chunk Length)  獨立小改動 → 測試
        ↓
Phase 3 (Auto-Maintain)     移除服務 → 測試
        ↓
Phase 4 (Note Embeddings)   核心重構 → 測試
        ↓
Phase 5 (UI 清理)           UI 調整 → 測試
        ↓
Phase 6 (清理文件)          最終驗證
```

---

## 預期成果

1. ✅ 更簡潔的架構 - 移除雙重 embedding 系統
2. ✅ 更少的設定項 - 降低用戶認知負擔
3. ✅ 更可預測的行為 - 只有手動觸發 embedding
4. ✅ 更好的搜尋精度 - chunk-based search 更精準
5. ✅ 正確的根目錄篩選 - 解決現有 bug
6. ✅ 簡化的 folder filter - 只有 exclude 模式
