# 06 — 实测记录（脚本 + 输出）

跑法：不用 Resolve，直接 `import()` 高级服务器的 **真实工具 handler**
（`S/tools/drx.mjs` 的 `drxTool.handler({action,args})`），与 MCP 调用完全同一条代码路径。
另外用**实时 MCP 工具** `mcp__resolve_advanced__drx` 做了两次端到端调用。

环境：macOS arm64，Node v26.13.0，`sharp` 缺失，`zlib.zstdCompressSync` 可用，
ffmpeg/ffprobe 在 `/opt/homebrew/bin`。

---

## 0. 依赖自检

```bash
$ node -v
v26.13.0
$ node -e "try{require.resolve('sharp');console.log('sharp OK')}catch(e){console.log('sharp MISSING')}"
sharp MISSING
$ node -e "console.log('native zstd', typeof require('zlib').zstdCompressSync)"
native zstd function
$ which ffmpeg ffprobe
/opt/homebrew/bin/ffmpeg
/opt/homebrew/bin/ffprobe
```

## 1. 实时 MCP：`scope_read`（确认 sharp 阻塞）

调用：
```json
{"action":"scope_read","args":{"png":"/tmp/nonexistent-frame.png"}}
```
输出：
```
Error: {
  "error": "scope-read needs the optional dep 'sharp' (frame stats). Install: npm i sharp"
}
```
→ 所有帧统计类 action 在当前 profile 下不可用（正文 §8.1）。

## 2. 实时 MCP：`generate` + `parse`（确认可用、确认 `_raw` 体积）

```json
{"action":"generate","args":{
  "gradeParams":{"space":"ui","gain":{"r":1.04,"g":1,"b":0.97,"master":1},"contrast":1.08},
  "metadata":{"label":"contract-check"},
  "outputPath":"/tmp/contract-check.drx"}}
```
输出：
```json
{ "outputPath": "/tmp/contract-check.drx", "bytes": 1509 }
```

```json
{"action":"parse","args":{"drxPath":"/tmp/contract-check.drx"}}
```
输出（关键字段）：
```jsonc
{
  "label": "contract-check", "width": 1920, "height": 1080, "pTrackVerXml": null,
  "nodes": [{
    "id":1,"index":1,"xPos":500,"yPos":300,"label":"contract-check","color":null,
    "enabled":true,"keyframed":false,
    "correctors":[
      {"type":1,"typeName":"Primary","enabled":true,
       "parameters":[{"id":100663325,"value":1.0399999618530273,"name":"gain.r"},
                     {"id":100663327,"value":0.9700000286102295,"name":"gain.b"},
                     {"id":2248147137,"value":1.0800000429153442,"name":"contrast.master"}]},
      {"type":2,"typeName":"Qualifier","enabled":true,
       "parameters":[{"id":2284847105,"value":{"F2":0},"name":"qualifier.mode"}]}   // companion 块
    ],
    "params":{"lift":{...},"gain":{"r":1.04,"g":1,"b":0.97,"master":1},...,"saturation":50,"contrast":1.08,"pivot":0.435},
    "customCurves":null,"hslCurves":null,"qualifier":{"mode":0},"powerWindow":null
  }],
  "connections": [],
  "toolBreakdown": {"gain":{"r":1,"g":1,"b":1,"master":1},"saturation":50,"activeTools":[],"summary":""},
  "valueFidelity": {"level":"calibrated-subset-only", "note":"..."}
}
```
工具回执末尾：`(Omitted 1841303 bytes)` → `_raw` 1.8MB（正文 §3.1）。

## 3. 离线：四层节点图（`generate` → `merge` → `parse`）

脚本 `/tmp/drx-test.cjs`（核心）：

```js
const { drxTool } = await import(
  '$HOME/Library/Application Support/davinci-resolve-mcp/resolve-advanced/server/tools/drx.mjs');
const call = (action, args) => drxTool.handler({ action, args });

const base = await call('generate', { gradeParams: {
  space: 'ui',
  lift:   { r: 0, g: 0, b: 0, master: 0.005 },
  gain:   { r: 1.04, g: 1.0, b: 0.97, master: 1.0 },
  contrast: 1.08, pivot: 0.435,
}, metadata: { label: 'AUTO:global_cdl v1' } });

const merged = await call('merge', {
  baseContent: base.content,
  newNodes: [
    { label: 'AUTO:skin_key v1', params: {
        space: 'ui',
        qualifier: { hueCenter: 33, hueWidth: 22, hueSoft: 11,
                     satLow: 12, satHigh: 88, satLowSoft: 5, satHighSoft: 5,
                     lumLow: 20, lumHigh: 80, lumLowSoft: 5, lumHighSoft: 5 },
        gain: [1.03, 1.01, 1.0, 1.0] } },
    { label: 'AUTO:highlight_glow v1', params: {
        space: 'ui',
        lumaQualifier: { lumLow: 70, lumHigh: 100, lumLowSoft: 20, lumHighSoft: 10 },
        gain: [1.0, 1.0, 1.0, 1.06] } },
    { label: 'AUTO:bg_hue v1', params: {
        space: 'ui',
        window: { type: 5, pan: 80, tilt: 40, soft1: 30, opacity: 70 },
        gain: [0.98, 0.99, 1.03, 1.0] } },
    { label: 'AUTO:skin_win v1', params: {
        space: 'ui',
        qualifier: { hueCenter: 40, hueWidth: 18, hueSoft: 8, satLow: 15, satHigh: 90 },
        window: { type: 1, pan: 55, tilt: 45, size: 35, aspect: 60, soft1: 25 },
        gain: [1.05, 1.0, 0.98, 1.0] } },
  ],
});

const parsed = await call('parse', { content: merged.content });
```

输出：
```
BASE bytes 1559
MERGED bytes 3256
nodes 5
{"id":1,"index":1,"label":"AUTO:global_cdl","correctorTypes":[1,2],"saturation":0.02199999988079071,
 "gain":{"r":1.0399999618530273,"g":1,"b":0.9700000286102295,"master":1},"qualifier":{"mode":0},"powerWindow":null}
{"id":2,"index":2,"label":"AUTO:skin_key","correctorTypes":[1,2,2],
 "qualifier":{"mode":0,"hueCenter":33.000001,"hueWidth":22,"hueSymmetry":50,"hueSoft":11,
              "satHigh":88,"satLow":12,"satHighSoft":5,"satLowSoft":5,
              "lumHigh":80.000001,"lumLow":20,"lumHighSoft":5,"lumLowSoft":5,"modeFlag":4}}
{"id":3,"index":3,"label":"AUTO:highlight_glow","correctorTypes":[1,2,2],
 "qualifier":{"mode":0,"lumHigh":100,"lumLow":69.999999,"lumHighSoft":10,"lumLowSoft":20}}
{"id":4,"index":4,"label":"AUTO:bg_hue","correctorTypes":[1,2,65554],
 "powerWindow":{"type":5,"pan":80,"tilt":40,"soft1":30,"opacity":70}}
{"id":5,"index":5,"label":"AUTO:skin_win","correctorTypes":[1,2,2,4],
 "qualifier":{...},"powerWindow":{"type":1,"size":35,"aspect":60,"pan":55,"tilt":45,"soft1":25}}
connections 1→2→3→4→5
```

**读法**：NodeId/NodeIndex = `[1..5]/[1..5]`；HSL 与 luma qualifier 逐字段解码；gradient
（type 5）与 circle（type 1）窗口都解码；base 的 `saturation` 从 1.1 变成 0.022（坑，见 §5.5）。

## 4. 离线：merge 的两个损坏（对照实验）

```js
// A) base 自带 qualifier，merge 一个无关节点
baseQ  = generate({ gradeParams: { space:'ui', qualifier:{hueCenter:10,hueWidth:20,satLow:5,satHigh:95},
                                   gain:{r:1.1,g:1,b:1,master:1} } })
mergedQ = merge({ baseContent: baseQ.content, newNodes:[{label:'extra', params:{space:'ui', gain:{r:1,g:1.05,b:1,master:1}}}] })
parse(mergedQ) → node0.qualifier = {"mode":0}          // ❌ 次级丢失

// B) base 只带 gain/lift，merge 一个节点
baseG   = generate({ gradeParams: { space:'ui', gain:{r:1.08,g:1.02,b:0.95,master:1.01},
                                    lift:{r:0.01,g:0,b:0,master:0} } })
mergedG = merge({ baseContent: baseG.content, newNodes:[{label:'n2', params:{space:'ui', contrast:1.1}}] })
parse(mergedG) → node0.params.gain = {1.08,1.02,0.95,1.01}   // ✅ 保留
```
```
A) base qualifier after merge: {"mode":0} sat: 50
B) base gain after merge: {"r":1.0800000429153442,"g":1.0199999809265137,"b":0.949999988079071,"master":1.0099999904632568}
   lift {"r":0.019999999552965164,"g":0,"b":0,"master":0} contrast 1
```

saturation double-scale 对照：
```
BASE parse sat= 1.100000023841858      // UI 55 → wire 1.1
merge 后 node0.saturation = 0.02199999988079071   // 1.1/50
```

## 5. 离线：RGB qualifier / polygon window / R21 window / lumMix 警告

```js
// RGB qualifier 原始 wire
rgb = generate({ gradeParams: { space:'ui',
  rgbQualifier:{ rLow:12, rHigh:88, gLow:22, gHigh:78, bLow:32, bHigh:68 },
  gain:{r:1,g:1,b:1,master:0.95} } })
parse(rgb).nodes[0].correctors.flatMap(c=>c.parameters)
→ [{gain.master}, {qualifier.mode:{F2:0}},                       // companion
   {qualifier.rgbRLow:0.11999999731779099}, {qualifier.rgbRHigh:0.8799999952316284},
   {qualifier.rgbGLow:0.2199999988079071},  {qualifier.rgbGHigh:0.7799999713897705},
   {qualifier.rgbBLow:0.3199999928474426},  {qualifier.rgbBHigh:0.6800000071525574},
   {qualifier.mode:{F2:2}}]                                       // 真实 mode
parse(rgb).nodes[0].qualifier → {"mode":0}                        // 解码坑

// Polygon window
poly = generate({ gradeParams: { space:'ui',
  rgbQualifier:{...}, window:{ type:3, vertices:[{x:-400,y:-300},{x:400,y:-300},
                                                  {x:400,y:300},{x:-400,y:300}] },
  gain:{r:1,g:1,b:1,master:0.95} } })
→ correctorTypes [1,2,2,6]
→ params.polygonVertices: 13 点 ring（首角×2/其余×3/闭合×2）
→ powerWindow: null

// Resolve 21 窗口
r21 = generate({ gradeParams: { space:'ui',
  window:{type:1,pan:55,tilt:45,size:35,aspect:60,soft1:25},
  gain:{r:1,g:1,b:1,master:1.02} }, resolveVersion: 21 })
→ correctorTypes [1,2,65540]   // 65540 = 0x10004
→ powerWindow {"rotate":0,"aspect":60,"size":35,"pan":55,"tilt":45,"type":1,"soft1":25}

// Lum Mix 警告
warn = generate({ gradeParams:{ space:'ui', gain:{r:1.2,g:1.2,b:1.2,master:1}, lumMixSlider:100 } })
→ warnings: ["gain R=G=B=1.2 with Lum Mix 100: Resolve cancels 100% of an equal R/G/B move on luma
              (100 renders unchanged); use gain.master, or leave lumMixSlider unset for per-channel gain."]
```

## 6. 离线：`generate_from_request` 不可用 / `export_cdl` 饱和度过缩放 / `verify_grade` / `lut_apply`

```js
const r  = await call('generate_from_request', { request: { request: 'make it warm and punchy' } });
// → { buffer: {type:'Buffer', data:[...]}, resolved:{tools,params,intent,metadata} }
const r2 = await call('generate_from_request', { request:{request:'warm', nodeLabel:'L1'},
                                                 outputPath: '/tmp/gfr.drx' });
// → 仍返回 { buffer, resolved }，/tmp/gfr.drx 没写   ❌

const cdl = await call('export_cdl', { content: g.content });   // g 是 UI saturation 60 的 grade
// → { format:'cdl', cdl:{ slope:{...}, offset:{...}, power:{...},
//                        saturation: 0.024000000953674317 } }   // 60→wire 1.2→/50=0.024  ❌

const v1 = await call('verify_grade', { intended:{content:g.content}, applied:{content:g.content} });
// → verdict 'landed', counts {landed:1,drifted:0,missing:0,unverifiable:0,extra:0}

const v2 = await call('verify_grade', { intended:{content:g.content}, applied:{content:g2.content} });
// → verdict 'drifted', nodes[0].deltas=[
//     {param:'gain.r',intended:1.1,applied:1.2,delta:0.1},
//     {param:'saturation.primary',intended:1.2,applied:0,delta:1.2},
//     {param:'contrast.master',intended:1.1,applied:1,delta:0.1}]
//   nodes[0].unverifiableParams=['qualifier.mode']  ← companion 块造成，正常

const l = await call('lut_apply', { content:g.content, lutPath:'Kodak_5219.cube', nodeIndex:0 });
// → { lutPath:'Kodak_5219.cube', slotMeta:6, nodeIndex:0, verified:true,
//      liveConfirm:'pending (live validation)', bytes:1436 }
```

## 7. `sharp` 缺失下各 action 的失败文案（供插件做可用性判断）

```
scope_read  → "scope-read needs the optional dep 'sharp' (frame stats). Install: npm i sharp"
skin_match  → "skin-match needs the optional dep 'sharp' (frame stats). Install: npm i sharp"
（同族：shot-match / white-balance-match / contrast-normalize / match-to-reference /
  saturation-match / black-balance / tone-curve-transfer / gamut-legal 各自有同样前缀的文案，
  见各模块 loadSharp()）
```

## 8. 复现脚本存放

本次临时脚本在 `/tmp/drx-test.cjs`、`/tmp/drx-test2.cjs`、`/tmp/drx-test3.cjs`
（未放进仓库）。需要重跑时按上面各节的代码片段重建即可；全部只用 `resolve-advanced/`
已有依赖与 Node 内置模块，**不需要安装任何包**。

## 9. `cdl_io` 桥（`lib/layers.mjs` 的 CDL → .drx，实测）

```js
const cdlXml = `<?xml version="1.0"?>
<ColorCorrectionCollection xmlns="urn:ASC:CDL:v1.01">
  <ColorCorrection id="global">
    <SOPNode>
      <Slope>1.04 1.0 0.97</Slope>
      <Offset>0.01 0.0 -0.01</Offset>
      <Power>1.1 1.0 0.95</Power>
    </SOPNode>
    <SatNode><Saturation>1.1</Saturation></SatNode>
  </ColorCorrection>
</ColorCorrectionCollection>`;

const r = await call('cdl_io', { content: cdlXml, outDir: '/tmp/davinci-panel-test/cdl' });
```
输出：
```json
{"imported":1,
 "grades":[{"id":"global","drxPath":"/tmp/davinci-panel-test/cdl/global.drx","identity":false}],
 "warnings":["power→gamma is a model conversion (Resolve gamma ≠ ASC power); the look is approximate by design, not a 1:1 transfer. Validate against the on-set reference."]}
```

生成的 `.drx` parse 回读：
```json
{"lift":{"r":0,"g":0,"b":0,"master":0},
 "gamma":{"r":-0.09090909361839294,"g":0,"b":0.05263157933950424,"master":0},
 "gain":{"r":1.0399999618530273,"g":1,"b":0.9700000286102295,"master":1},
 "offset":{"r":0.009999999776482582,"g":0,"b":-0.009999999776482582},
 "saturation":1.100000023841858,"contrast":1,"pivot":0.435}
correctors: [1,2]
```

**读法**：
- `Slope → gain`（原样：1.04/1.0/0.97 ✅）
- `Offset → offset`（原样：0.01/0/-0.01 ✅）
- `Power → gamma`（模型转换，非线性：1.1→−0.0909、0.95→+0.0526）
- `Saturation → saturation`（schema 注释说 “sat (0–2)→Resolve sat (0–100)”，回读是 raw 1.1）
- ⚠️ 这个 base 的 `saturation` 是 raw 1.1，**再 merge 会被二次缩放成 0.022** —— 与 §5.5 的坑一致。
  所以 `cdl_io` 的 base 要么直接 apply（单节点），要么把饱和度放到 `newNodes` 里。

