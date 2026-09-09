# maple-pod / resources

Maple Pod 的資源建置與發佈管線。負責把 MapleStory BGM 的清單、音檔、標記圖與背景圖，
整理成前端可直接取用的靜態資源，並發佈到本 repo 的 `gh-pages` 分支。

前端不透過 GitHub Pages 取用（本 repo 未啟用 Pages），而是走 jsDelivr／raw.githubusercontent：

```
https://cdn.jsdelivr.net/gh/maple-pod/resources@gh-pages/data.json
```

## 產出物

發佈到 `gh-pages` 的內容：

| 路徑 | 說明 |
| --- | --- |
| `data.json` | 曲目 metadata（含 `duration` 與實際 `audio.file` / codec / container）＋ 所有標記圖的 deflate 資料，前端用 fflate 解開 |
| `bgm/*` | yt-dlp 選到的最佳可用音源，保留來源 codec/container（例如 WebM/Opus、M4A/AAC），不統一轉 MP3 |
| `mark/*.png` | 標記圖原檔 |
| `bg/*.jpg` | 背景圖（1920×1080） |
| `bg/bg.json` | 背景圖清單＋壓縮過的縮圖預覽（240×135） |
| `world-map/world-maps.json` | canonical GMS-native world-map 合約（schema version 6、`graph.roots`/`graph.nodes` hierarchy、WZ geometry/assets、direct spots、BGM selection、localization 與 provenance；保留 Wiki corroboration 欄位） |
| `world-map/manifest.json` | runtime world-map manifest（schema version 1、roots、節點索引、來源/資產版本與 graph cache key） |
| `world-map/nodes/*.json` | 每個 game-native `worldMapId` 一個 runtime chunk；完整 node 與 embedded localization，供前端按需載入 |
| `world-map/*` | WZ base/link PNG assets；由 graph asset path 引用，建置時驗證 SHA-1 與尺寸 |

## 前置需求

**所有指令都在容器內執行，不要直接在主機上跑。** 管線依賴 `yt-dlp`、`ffprobe` 與
能執行 JS 的 runtime，主機上通常沒有這些工具，硬跑只會得到難以診斷的失敗。
`build` / `process-bgs` / `world-map:generate` / `deploy` 會自行偵測執行環境，在主機上直接被擋下。

先建立環境映像（只需在 Dockerfile 變動時重做）：

```bash
./build-env.sh
```

再準備 `.env`（不進版控）：

```bash
GLOBAL_GIT_PATH=/path/to/your/.gitconfig   # 掛進容器的 git 身份，預設 $HOME/.gitconfig
CONTAINER_USER=yourname                     # 容器內的使用者名稱，預設取自 whoami
GH_TOKEN=github_pat_...                     # 發佈用，需要本 repo 的 contents:write 權限
```

## 操作流程

`dev.sh` 是唯一的入口：帶參數就在容器內執行該指令，不帶參數則進入互動 shell。

```bash
./dev.sh                        # 進入容器的互動 shell
./dev.sh pnpm install           # 第一次使用，或依賴有變動時

./dev.sh pnpm run build         # 抓取曲目：下載音檔與標記圖、ffprobe 取長度、產生 data.json
./dev.sh pnpm run process-bgs   # 背景圖：assets/bg/*.png → output/bg/*.jpg + bg.json
./dev.sh pnpm run world-map:generate          # preview：bounded 維護/驗證資料
./dev.sh pnpm run world-map:generate:full     # full：正式完整 native graph / localization 產物
./dev.sh pnpm run deploy        # 把 output/ 提交並推送到 gh-pages

./dev.sh pnpm run lint
./dev.sh pnpm run lint:fix
./dev.sh pnpm run typecheck
```

> **一律用 `pnpm run <script>`。** `pnpm deploy` 會被 pnpm 內建的 `deploy` 子命令攔截，
> 不會執行本專案的腳本。

`dev.sh` 預設以 `sudo docker` 呼叫；不需要 sudo 的環境可以用 `DOCKER=docker ./dev.sh ...`。

`node_modules` 與 pnpm store 都落在專案目錄內，而容器一律把專案掛在 `/workspace`，
所以只要固定從容器操作，就不會出現 `ERR_PNPM_UNEXPECTED_STORE`（同一份 `node_modules`
被不同絕對路徑安裝過所導致）。反過來說，**在主機上跑過 `pnpm install` 會破壞這個一致性**。

編輯器的 ESLint 整合仍在主機上運作（`lint` / `typecheck` 沒有容器限制，它們不需要外部工具），
命令列操作則統一走 `./dev.sh`。

## 增量建置

`build` 是增量的，狀態記在 workspace 根目錄的 `.build-state.json`（已被 gitignore）：

- 每完成一個項目就寫入一次，中斷後重跑會從斷點續做。
- 每次啟動會先跟 `output/` 的實際檔案對帳：state 指向的音檔被手動刪掉時會重新下載。
  音檔 state 會記錄實際 filename / codec / container；舊版只記 MP3 filename 的 state 會自動失效並重新抓來源。
- 失敗的項目記在 `failedBgms` / `failedMarks`，下次執行會自動重試。
- 有任何失敗時會在根目錄產生 `error-<timestamp>.log`，且行程以 exit code 1 結束。

想完整重建，刪掉 `.build-state.json` 與 `output/` 對應的檔案即可。

中途中斷是安全的：未完成的下載會留下 `output/bgm/_tmp_*`，下次啟動時會自動清掉。

## 發佈的行為

`deploy` 把 `output/` 當成獨立的 git repo（orphan `gh-pages` 分支）操作：

- JSON 與 PNG 先進一個 commit，音檔每 100 個一批，避免單一 commit 過大；音檔副檔名不再限定 MP3。
- **不使用 `--force`**。若本機 `output/` 的歷史與 `origin/gh-pages` 分歧，推送會直接失敗，
  需要人工判斷後處理，不會靜默覆蓋遠端。
- deploy 會將 world-map/world-maps.json、world-map/manifest.json、world-map/nodes/*.json、world-map/images/* 與 world-map/gms/<version>/**/* native WZ PNG 納入 metadata/image commit；
  world-map generation 不會由一般 build 或 CI 隱式觸發。
- `GH_TOKEN` 只在 `git push` 當下以參數傳入，**不會寫進 `output/.git/config`**；
  腳本每次執行也會把 remote 重設回不帶 token 的 URL，順手清掉舊版留下的憑證。

## 疑難排解

**yt-dlp 抓取失敗、或出現 `No supported JavaScript runtime` 之類的警告**

YouTube 端變動頻繁，yt-dlp 需要跟著更新。重建映像即可取得最新版：

```bash
./build-env.sh
```

若最新版本本身有問題，可以釘回已知可用的版本：

```bash
YTDLP_VERSION=2026.01.15 ./build-env.sh
```

`build-resources.ts` 以 `jsRuntimes: 'node'` 讓 yt-dlp 使用映像內建的 Node 作為 JS runtime，
因此不需要另外安裝 deno。

音訊下載使用 `bestaudio/best` 並直接保留 yt-dlp 選中的來源 representation；不使用
`--extract-audio`、不指定 `--audio-format mp3`，也不再使用 codec format-sort 去偏好某個轉檔格式。
若 yt-dlp/FFmpeg 只做 container fixup/remux（例如 M4A 修正），音訊 stream 仍不會重新編碼。

**推送被拒（non-fast-forward）**

代表 `output/` 的本機歷史與 `origin/gh-pages` 對不上，通常是 `output/` 被重建過。
確認遠端內容後再決定要 rebase、合併，還是刻意重建分支——腳本不會替你做這個決定。

## 已知限制

- `gh-pages` 分支目前約 2.4 GB 且只增不減，已超過 GitHub 建議的 1 GB。
  短期還能運作，但曲目再成長就需要改變發佈方式（例如每次重建 orphan 分支壓掉歷史，
  或改用物件儲存）。
- CI（`.github/workflows/ci.yml`）跑 lint、typecheck 與離線 world-map regression tests；
  資源抓取刻意不上 GitHub runner：YouTube 對資料中心 IP 封鎖嚴重，且產出量不適合 hosted runner。

## World-map contract

目前發布契約是 schema v6；canonical navigation graph 使用原生 `roots` + `nodes`，不把舊的 flat `worlds[]` 假裝成階層。

每次 `world-map:generate` 或 `world-map:generate:full` 在寫出 canonical `world-maps.json` 後，都會同步編譯 `manifest.json` 與 `nodes/<worldMapId>.json` runtime resources。runtime manifest 的 `cacheKey` 是 canonical graph 的 SHA-256（不含 `generatedAt`）；preview/full 都會把 acquisition 跳過的 parent 或 link target 保留為 node 原生 reference，並在 node index 的 `missingParentWorldMapId`、`missingLinkTargetWorldMapIds` 與 manifest 的 `unresolved` summary 明確列出，不會靜默忽略或把 orphan 升格成 root。canonical JSON 不由 runtime compiler 改寫或取代。

`world-map:generate` 是 online-only 的 **preview** 維護者命令；`world-map:generate:full` 才會產生正式完整資料。兩者都不下載或解析 MapleStory client data，也不執行 YouTube/resource 全量下載。preview 保留 bounded WorldMap depth、最多 32 筆 representative GMS map detail 與 sampled localization，供開發/CI 前的快速驗證；full 會從 MapleStory.IO `/map/worldmap` native index 枚舉並 best-effort 驗證完整 WorldMap screens、追蹤額外 link targets、保留所有 spot `mapNumbers`，並對每個 visual spot 的 representative numeric map 逐筆取得 GMS detail/BGM。full localization 使用各 region `/map` bulk index 一次取得 map name/streetName，再只對 link-bearing WorldMap screens 做 sequential best-effort native localization fetch，避免逐 map localization request。
所有 remote acquisition 維持 sequential 約 1 秒 request delay；單次 MapleStory.IO/image request 有 bounded timeout、有限次 retry，且同一執行個體會 cache/dedupe native world-map/map/list requests。WZ base/link PNG 保留原 bytes 並驗證 SHA-1 與 dimensions。CI 只執行 offline tests，不會隱式執行 full generation。

可選擇使用已產生的 Maple Pod catalog 作為輸入；未提供參數時使用 `maplestory-music/maplebgm-db` 的 `bgm.min.json`：

```bash
./dev.sh pnpm run world-map:generate:preview output/data.json
# production data refresh:
./dev.sh pnpm run world-map:generate:full output/data.json
```

取得或解析失敗、必要圖片缺失、圖片完整性錯誤、contract validation 失敗都會以非零狀態結束。Wiki BGM key 若在目前 catalog 中找不到唯一 identity，會保留在 `bgm.unmappedKeys` 並列為 warning，不會猜測 tracks；兩個 regression samples 預期 `unmappedKeys` 為零，且鎖定 Victoria Island `111 / 102 / 102`、Cernium `29 / 28 / 28`。

每個 landmark 的 `selection` 是 frontend 直接使用的單一曲目欄位：`{ trackId, source }`，其中 `source` 為 `gms-map-bgm`、`wiki` 或 `null`。numeric GMS map 若有 `backgroundMusic`，會保留原始 `gameBgm.path`，只用 exact case-sensitive `structure/filename` catalog path match 選曲；valid GMS path 未能唯一對應 catalog 時 selection 維持 `null`，不會靜默改用 Wiki。`tracks`、`bgm.sourceKeys` 與 `bgm.unmappedKeys` 是 Wiki evidence 相容欄位；`bgm.reconciliation` 記錄 `agree`、`disagree`、`gms-unmapped` 或 map-less region 的 `wiki-fallback`。`target.mapMark` 永遠只是遊戲原生 grouping metadata，不是曲目選擇器。

World-map contract 的 identity 欄位有三個不同語義：`target.mapId` 是遊戲內 numeric map identity；`target.worldMapId` 是 MapleStory.IO 拓撲中的 game-native `WorldMap...` node，只有在 links 或 deterministic map evidence 提供證據時才填入；`target.mapMark` 是 GMS map detail 的 game-native marker/grouping signal，與 maplebgm-db 的 `mark` 最多只能做 corroboration/report，不能建立或覆寫 canonical 值，也不等同於 `worldMapId`。例如 Sleepywood 的 `worldMapId` 是 `WorldMap012`、`mapMark` 是 `Dungeon`。

`target.name` 永遠是 GMS canonical game-data name；`target.localizedNames` 是獨立的 display enrichment，key 使用 locale，內容同時記錄 `name`、`status`、source region/version/API base 與 strict join (`mapId` 或 `worldMapId`)。`status: "available"` 時，`name` 與 `join` 必須成對出現；`status: "unavailable"` 明確表示該 locale 的 version resolution/acquisition 失敗，`name` 與 `join` 都是 `null`。目前啟用 `ko-KR/KMS`、`ja-JP/JMS`、`zh-CN/CMS`、`zh-TW/TWMS`、`en-SG/SEA`，版本會從 `/api/wz` 各自解析最新 ready numeric version；locale 失敗只產生 warning/provenance/null entry，不中止 canonical GMS generation。preview 仍只查代表性 map/world-map localization；full 則利用每區服 `/map` bulk index 覆蓋 graph 中所有 map IDs 的 display name，並 best-effort 查詢所有 link-bearing native WorldMap screens 以對應 region/link 翻譯。欄位缺失或 join 不可靠時，locale entry 仍保留 `name: null`；不會把 GMS canonical name 複製成翻譯，frontend 才決定 fallback。EMS 目前未啟用，因 sampled EMS 92 的 world-map topology 已與 canonical GMS 不完整相容（`WorldMap230` request 失敗且 Victoria links 不同）。

Live generation 會先從 MapleStory.IO `/api/wz` 選擇指定 region 中最新的 ready、含圖片、純 numeric 版本；目前 GMS resolves to `270`。離線 regression fixture 固定使用 GMS `270`，因此 CI 不依賴網路，但日後 live topology 可能隨最新版本改變。MapleStory.IO 的 WZ `/map/worldmap/{id}` 現在是 hierarchy、image、link placement 與 direct spot geometry 的 authority；Wiki 只作 hotspot/BGM/revision corroboration 與額外 metadata。GMS 是 canonical identity/topology/default name；其他 region 只提供可為 `null` 的 display localization，不得覆寫 GMS。MapleStory.IO map detail 的 `backgroundMusic` 仍是 numeric map selection authority，`mapMark` 僅是 metadata。

Map-less Wiki links 優先透過 parent `links[].toolTip/linksTo`、map-number overlap 與 map detail 的 exact name/`streetName`/`mapMark` evidence join；不會把 Wiki 標題 slugify 成 game ID，也不使用 substring/fuzzy title match。對仍缺少 mapMark 的 region，Wiki target page 的 `MapIcon` filename 只作 bounded GMS map-search hint，再與已知 world-map mapNumbers 交集並 fetch detail；只有唯一候選與 exact name/streetName 證據才接受 GMS mapMark。search 失敗、零結果或 ambiguous intersection 都保留 null。這條 enrichment 不會建立 worldMapId。若 Wiki 只是 editorial grouping、沒有獨立 child WorldMap node，會保留 `worldMapId: null`，必要時只填來自 GMS map detail 的獨立 `mapMark`，不會從 maplebgm-db catalog `mark` 創造 canonical mapMark。手動 fallback 不是 sample 的主要路徑，且若未經審核不可通過 contract validation。GMS 是唯一 canonical game-data source；其他 region 只做 optional display/localization enrichment，不得改變 `mapId`、`worldMapId`、`mapMark` 或 canonical `name`。若同一 game map 在 source 暴露多個 visual hotspot，會保留每個 hit-test hotspot；它們共享同一 `mapId`/logical identity，`map:<mapId>~<left>-<top>` 僅是以 source pixel anchor 做 deterministic visual disambiguation，不代表多個遊戲地圖。
