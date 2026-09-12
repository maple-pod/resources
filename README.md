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
| `world-map/catalog.json` | region/version snapshot catalog；目前 logical region 為 GMS/TWMS，保留 provider-native `TMS`/`TWMS` 差異、歷史 milestone metadata 與已產生 snapshot fingerprint |
| `world-map/snapshots/<region>/<version>/world-maps.json` | exact region+version canonical world-map snapshot（schema version 7 graph contract） |
| `world-map/snapshots/<region>/<version>/manifest.json` | 該 snapshot 的 progressive runtime manifest |
| `world-map/snapshots/<region>/<version>/nodes/*.json` | 該 snapshot 每個 game-native `worldMapId` 的 runtime chunk |
| `world-map/snapshots/<region>/<version>/assets/*` | 該 snapshot 的 WZ base/link PNG；asset identity 不再只靠 WorldMap ID |
| `world-map/world-maps.json`, `world-map/manifest.json`, `world-map/nodes/*.json` | `GMS/270` 的相容性 alias；前端遷移到 catalog 後可移除 |
| `world-map/images/*` | 舊 Wiki corroboration 圖片；只供 legacy GMS worlds[] contract 使用 |

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
./dev.sh pnpm run world-map:generate -- --snapshot=GMS/270       # preview：隔離寫到 output/world-map-preview/
./dev.sh pnpm run world-map:generate:full -- --snapshot=GMS/270  # full：正式完整 snapshot
./dev.sh pnpm run world-map:generate:full -- --snapshot=TWMS/209 # MapleStory.IO provider code 會自動路由到 TMS/209
# resumable public-baseline verifier；預設兩個 snapshot workers，結果/checkpoint 留在 ignored output/
./dev.sh pnpm run world-map:verify-baselines -- --concurrency=2
# 也可明確要求 provider 的 latest ready snapshot：--snapshot=GMS/latest 或 TWMS/latest
# archived-WZ：先 plan（只檢查 metadata/header/listing，不抓 payload block）
./dev.sh pnpm run world-map:sync -- --snapshot=TWMS/158 --member=String.wz --plan
# 再依需要 selective sync；String.wz 與 Map.wz 分開快取
./dev.sh pnpm run world-map:sync -- --snapshot=TWMS/158 --member=String.wz
./dev.sh pnpm run world-map:sync -- --snapshot=TWMS/158 --member=Map.wz
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
- deploy 會將 world-map/catalog.json、versioned `world-map/snapshots/<region>/<version>/...`、相容性 world-map/world-maps.json / manifest / nodes、world-map/images/* 與舊版 world-map/gms/<version>/**/* 納入 metadata/image commit；
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

versioned snapshot 發布契約是 schema v7；未版本化的 `GMS/270` compatibility alias 仍維持 legacy canonical v6 / runtime v1，直到前端完成 catalog migration。canonical navigation graph 使用原生 `roots` + `nodes`，不把舊的 flat `worlds[]` 假裝成階層。

`world-map:generate` 與 `world-map:generate:full` 都會同步編譯 `world-maps.json`、`manifest.json` 與 `nodes/<worldMapId>.json` runtime resources；preview 全部隔離在 `output/world-map-preview/`，full 才寫入可部署的 `output/world-map/`。runtime manifest 的 `cacheKey` 是 canonical graph 的 SHA-256（不含 `generatedAt`）；preview/full 都會把 acquisition 跳過的 parent 或 link target 保留為 node 原生 reference，並在 node index 的 `missingParentWorldMapId`、`missingLinkTargetWorldMapIds` 與 manifest 的 `unresolved` summary 明確列出，不會靜默忽略或把 orphan 升格成 root。canonical JSON 不由 runtime compiler 改寫或取代。

`world-map:generate` 是 bounded 的 **preview** 維護者命令；`world-map:generate:full` 才會產生正式完整資料。MapleStory.IO 與 MapleArchive snapshot 會透過 HTTP acquisition；已 materialize 的 archived-WZ snapshot 則直接解析本機快取的 client `String.wz` / `Map.wz`，generation 本身不重新下載 archive，也不執行 YouTube/resource 全量下載。preview 保留 bounded WorldMap depth、最多 32 筆 representative map detail 與 sampled localization，供開發/CI 前的快速驗證。對 MapleStory.IO，full 會從 exact `/map/worldmap` native index 枚舉並驗證完整 WorldMap screens、追蹤額外 link targets、保留所有 spot `mapNumbers`，並對每個 visual spot 的第一個 numeric map 逐筆取得同版本 map detail/BGM；再以同版本 `/map` bulk index 補齊所有 map/street strings，並逐一取得 String WZ 的 WorldMap name key。這些 detail/name request 仍是 sequential，因為 bulk map list 沒有 `backgroundMusic`，不能取代 BGM authority。full 若 index-listed WorldMap fetch 在 retries 後失敗（包括 deterministic 404），會以結構化 completeness error 終止，不能寫入或標成 selectable；若啟用 strict raw-WZ audit，則先以同 snapshot 的 raw `Map/WorldMap` inventory 判定存在性：raw inventory 缺少 normalized index 或 linked target 時，會保留 explicit unresolved/nonexistent reference，不把 normalized endpoint 的誤導性 500 當成 acquisition failure；raw inventory 確實包含的 target 若 fetch 失敗，或 raw inventory unavailable/malformed，仍阻止 full publish。未啟用 raw audit 時，額外由 link/request queue 觸發、但不在 exact index 的 WorldMap 若是 deterministic `not-found` 或 `unrenderable`，則保留明確 unresolved reference並可維持 complete，`transient` 或 `invalid` 則阻止 full publish。只有歷史上合理的 representative map-detail 或 String/WorldMap name-table 404 可保留 null/warning。MapleArchive 與 archived-WZ 則分別使用 release API 與本機 WZ parser，不走這組 MapleStory.IO `/map` calls。
所有 remote acquisition 維持 sequential 約 1 秒 request delay；MapleStory.IO 的 timeout 是**每次 request、每次 retry attempt** 的 bounded timeout（目前 15 秒，最多 2 次 retry），不是整個 full generation 的總 timeout。full 因而可能很慢：它必須抓每個 native WorldMap、representative map detail 與 String name；client 會在同一執行個體內 cache/dedupe 已發出的 world-map/map/list request，verifier 另會將 exact region/version 的 normalized JSON response 持久化到 ignored cache，讓中斷後只重抓缺失或 transient/invalid path。WZ base/link PNG 保留原 bytes 並驗證 SHA-1 與 dimensions。CI 只執行 offline tests，不會隱式執行 full generation。

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

World-map generation 現在以 **logical region + exact version** 為 resource identity。預設固定 `GMS/270`，避免「latest」在沒有明示的情況下改變已發布 identity；仍可用 `--snapshot=GMS/latest` / `TWMS/latest` 明確要求 MapleStory.IO 最新 ready numeric snapshot，resolved version 會寫入實際輸出路徑與 provenance。Taiwan 的 provider code 不是產品 identity：`TWMS/209` 會路由到 MapleStory.IO `TMS/209`，`TWMS/217+` 則路由到 `TWMS/<version>`。MapleStory.IO adapter 可直接生成其 HTTP archive 覆蓋的 snapshot；`TWMS/122` 則由 MapleArchive 的 exact-release HTTP adapter 產生完整 snapshot，已完成 live generation 驗證。MapleArchive 提供 release-specific WorldMap topology、sprites 與 map revisions，但沒有 authoritative `String/WorldMap.img` endpoint，因此該 provider 的 screen title 仍可能使用 inbound tooltip fallback；它不是 archived-WZ。

`TWMS/124`、`TWMS/158`、`TWMS/171` 已實作 archived-WZ source 與 generation path。它們不是 MapleStory.IO HTTP snapshot：`world-map:sync` 會從 Archive.org 以 HTTP Range 只 materialize 指定 WZ member 所在的 7z compressed block，再由 generation 解析 exact client WZ；124 的 `String.wz` 沒有 `WorldMap.img` 時，canonical screen title 會明確回到 inbound-link evidence，158/171 則可使用同版本 String WZ names。generation 只接受 exact logical region/version 的 `String.wz` 與 `Map.wz`，不會用鄰近版本或另一個 provider 偷換歷史資料。

MapleStory.IO raw WZ API 的 `/wz/{region}/{version}/Map/WorldMap` 會提供 exact `.img` inventory，`Map/WorldMap/<id>.img` 也會提供 WZ tree 與 base Canvas bytes；`String/WorldMap.img/<key>/name` 是同 snapshot 的 node-name authority。現在 full generation 會以成功的 raw `Map/WorldMap` inventory 作為 WorldMap existence authority：normalized `/map/worldmap/{id}` 仍只是 graph 所需的 link/spot transport；raw inventory 缺少的 normalized linked target 會保留為 explicit unresolved，raw inventory 多出的節點則必須由 normalized transport 成功取得，否則 full completeness 失敗。raw inventory 本身 unavailable/malformed 也會阻擋 publish。對 raw inventory 中確實存在的節點，strict audit 會以 bounded exact-version requests 驗證 BaseImg Canvas 結構與 payload digest、MapLink target/toolTip/image presence，以及 MapList spot/type/mapNo；WZ child index 順序不是 normalized API 的穩定 identity，因此 links 以 `linksTo`、spots 以完整 `mapNumbers` 集合（含 duplicate occurrence）對齊後再比對 geometry/content。request failure 與可證明的結構／bytes 差異會分別寫入 structured completeness diagnostics，任一項都阻止 full selectable publish。這個 raw tree cross-check 是目前 MapleStory.IO API 形狀下的最小充分邊界：API 已逐節點提供 WZ property tree，但沒有可靠的 recursive bulk response；直接再實作完整 `Map.wz` parser 只會重複解析並增加 acquisition 成本，不能改善已取得的 raw evidence。generation 使用 raw `String/WorldMap.img` names（`WorldMap -> 0`、numeric `WorldMapNNN -> NNN`）；只有該 String WZ key 不存在時才保留 inbound link tooltip fallback，不再把 tooltip 一律視為 canonical title。Raw `String/Map.img` 是 category-partitioned（例如 `victoria/100000000/mapName`、`streetName`），client 會在 exact region/version 下 bounded-cache category 與 mapId→category inventory，再只抓 graph 需要的 `mapName`/`streetName` leaves；raw leaf 存在時覆寫 normalized `/map` name/streetName，deterministic leaf absence 才 fallback，transient/invalid raw failures 會使 production full completeness 失敗。normalized endpoint 仍是 compatibility transport，不把 normalized response 偽稱為 raw leaf。Wiki 只作 hotspot/BGM/revision corroboration 與額外 metadata。MapleStory.IO map detail 的 `backgroundMusic` 仍是 numeric map selection authority，`mapMark` 僅是 metadata。

只有 **full** snapshot 會計算 topology / geometry / assets / WorldMap names / map details 五個 SHA-256 facet fingerprint 與 combined fingerprint，並在 `world-map/catalog.json` 標成 `selectable: true`。五個 facet 與 `combined` 都只描述 parsed graph resource payload；exact provider/version/archive provenance 由 catalog/source 欄位與 runtime manifest 驗證，不影響跨版本 payload equivalence、fingerprint comparison 或 `dataRef` 判斷。preview 是 bounded graph，只供維護驗證：它寫入獨立的 `world-map-preview/` root，不會碰 full snapshot、compatibility alias 或 deployable catalog，也不會把 partial fingerprint 當成正式資料。full generation 在沿用舊 catalog entry 前會重新驗證該 snapshot 的 canonical graph fingerprint、provenance、runtime manifest/cache key、全部 node chunks 與引用圖片（含 SHA-1）；任何缺檔或不一致都會把舊 entry 降回 `selectable: false` 並產生 warning，避免 frontend selector 指向 404/半毀 snapshot。這讓 selector 不會誤把 preview 或 stale output 當正式 snapshot，後續也能依 full fingerprint 做內容比較/dedup，而不是只看 node count。catalog 的 `worldMapDataDistinct` 會搭配 `worldMapComparedTo` 記錄比較基準；例如 GMS 178 對 177 的 WorldMap payload/String names 實測完全相同，而 GMS 224 對 223 即使 node inventory 相同，仍有 topology/geometry/assets/tooltips 差異。

`world-map:sync --snapshot=TWMS/158 --member=String.wz|Map.wz` 會分開 materialize 指定 member；`--plan`（`--inspect` 亦相容）只讀取 archive metadata、7z header、technical listing 與 packed-block 位置，不下載 member payload。輸出會顯示 member size/CRC、packed block 大小/offset 與 shared members。真正 sync 只抓該 member 所在的 compressed block；`Map.wz` 的 block 可能仍然很大，但不會抓整個 7z archive。每個 snapshot/member 快取在 ignored 的 `.cache/world-map/archived-wz/<region>/<version>/`，並寫入對應 manifest：archive file 的 pinned size/SHA-1、member size/CRC/SHA-256、packed range 與 parser provenance。sync 會在重用前驗證快取 member SHA-256 與 manifest；archive metadata、member listing、block layout 或 member hash 不符都會中止，不會產生可疑的 historical resource。新生成的 full archived-WZ output 會在 `GameDataSource.archivedWz` 發布 compact provenance：providerRegion/providerVersion、同一個 archive 的 item/file/SHA-1，以及實際用來編譯 graph 的 `String.wz` / `Map.wz` member name/SHA-256；不會發布 local filesystem path 或 packed offset。詳細 extraction provenance 仍留在 ignored cache manifest。generation 可直接解析已 materialize 的 archived client WZ，沒有 HTTP provider 的替代或跨版本 fallback。

公開 MapleStory.IO baseline verifier 會把每個 snapshot 放在 ignored 的 isolated run directory，將成功 checkpoint 綁定到已驗證的 canonical graph、runtime manifest/chunks 與 pure-content fingerprint；checkpoint schema 或 artifact 不相容時會重新執行，不會只因目錄存在就跳過。`world-map:verify-baselines --concurrency=2` 使用有限 worker 與每個 client 原有的 retry/timeout，單一 snapshot 失敗會留下原因並繼續其他 snapshot，不會發佈不完整結果。

維護者可用 `world-map:compare -- --left=output/world-map/snapshots/TWMS/124 --right=output/world-map/snapshots/TWMS/158 --json` 產生不修改 catalog 的 reproducible facet/node/link/asset/name/map-detail diff evidence；輸入應是兩個已完成 full snapshot artifact directory。輸出也會獨立列出 exact runtime source identity 是否相同；source identity 不會混入 pure-content fingerprint。

Catalog 的 `recommended` 是策展後的 public baseline 建議，不等於資料已存在；`selectable` 只表示該 exact snapshot 已完成 full generation，且 canonical graph、runtime manifest/chunks、引用資產、provenance 與 fingerprint 都通過驗證。Frontend 若只要顯示第一批公開基線，應使用 `recommended && selectable`；`recommended: false` 的 comparison/research entry 可保留在 catalog 作為歷史研究紀錄，不應自動變成公開選項。`worldMapDataDistinct` 與 `worldMapComparedTo` 是實際 WZ-level facet evidence；值為 `null` 表示尚未完成比較。`dataRef` 目前保留為未啟用的未來欄位，現階段不假設不同 release 可以 alias。

Map-less Wiki links 優先透過 parent `links[].toolTip/linksTo`、map-number overlap 與 map detail 的 exact name/`streetName`/`mapMark` evidence join；不會把 Wiki 標題 slugify 成 game ID，也不使用 substring/fuzzy title match。對仍缺少 mapMark 的 region，Wiki target page 的 `MapIcon` filename 只作 bounded GMS map-search hint，再與已知 world-map mapNumbers 交集並 fetch detail；只有唯一候選與 exact name/streetName 證據才接受 GMS mapMark。search 失敗、零結果或 ambiguous intersection 都保留 null。這條 enrichment 不會建立 worldMapId。若 Wiki 只是 editorial grouping、沒有獨立 child WorldMap node，會保留 `worldMapId: null`，必要時只填來自 GMS map detail 的獨立 `mapMark`，不會從 maplebgm-db catalog `mark` 創造 canonical mapMark。手動 fallback 不是 sample 的主要路徑，且若未經審核不可通過 contract validation。GMS 是唯一 canonical game-data source；其他 region 只做 optional display/localization enrichment，不得改變 `mapId`、`worldMapId`、`mapMark` 或 canonical `name`。若同一 game map 在 source 暴露多個 visual hotspot，會保留每個 hit-test hotspot；它們共享同一 `mapId`/logical identity，`map:<mapId>~<left>-<top>` 僅是以 source pixel anchor 做 deterministic visual disambiguation，不代表多個遊戲地圖。
Raw WZ remote audit responses 會另存於 ignored 的 `.cache/world-map/maplestory-io-raw-audit/<provider-region>/<version>/manifest.json`，manifest 綁定 `apiBase`、provider region/version 與每個 exact WZ path 的 response integrity digest。成功 node/leaf 與 deterministic 404 可跨 verifier restart 重用；transient/invalid response 會保留 failure journal 但不會被讀成成功，下一次只重試缺失或失敗 path。大型 Canvas 僅保存 non-empty/type 與 SHA-256 evidence，不把 base64 image bytes 複製進 cache；目前 API 的 `recursive`/`depth` query probe 沒有可靠 bulk response，因此 cache 是 resumable acquisition 的持久化邊界，不改變 raw authority 或 full completeness gate。Normalized `/map` JSON responses 則另存於 `.cache/world-map/maplestory-io-normalized/<provider-region>/<version>/manifest.json`；每個 entry 綁定 exact endpoint、source identity 與 response SHA-256，成功 response 與 deterministic 404 可重用，transient/invalid 只作 failure journal 並在下次重試。兩種 cache 都只影響 acquisition throughput，不改變 raw-WZ authority、normalized precedence 或 published artifacts。
