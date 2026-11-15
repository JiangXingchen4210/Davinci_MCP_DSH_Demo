# 01 — `drx` 工具 schema 与分派（摘录）

源码：`S/tools/drx.mjs`。以下为**逐字摘录**（去掉无关注释），行号即原始行号。

## 1. 匹配器 schema（`S/tools/drx.mjs:44-109`）

```js
const levelSchema = z.object({
  clips: z.array(z.object({ id: z.union([z.string(), z.number()]), png: z.string(), group: z.string() })),
  outDir: z.string(),
  mode: z.string().optional(),                       // default within_camera_mean
  clampGain: z.array(z.number()).length(2).optional(),
});

const skinMatchSchema = z.object({
  clips: z.array(z.object({ id, png, group })),      // png = DISPLAY-REFERRED
  outDir: z.string(),
  heroId: z.union([z.string(), z.number()]).optional(),
  clampGain: z.array(z.number()).length(2).optional(),
  minSkinFrac: z.number().optional(),                // default 0.01
  metric: z.enum(['mean', 'chroma']).optional(),     // default 'mean'
});

const shotMatchSchema = z.object({
  clips: z.array(z.object({ id, png, scene: z.string().optional() })),
  outDir: z.string(),
  mode: z.enum(['neutralize', 'hero']).optional(),   // default neutralize
  heroId: z.union([z.string(), z.number()]).optional(),
  clampGain: z.array(z.number()).length(2).optional(),
});

const blackBalanceSchema = z.object({
  clips: z.array(z.object({ id, png, group: z.string().optional() })),
  outDir: z.string(),
  clampOffset: z.array(z.number()).length(2).optional(),
});
```

## 2. 其余 schema（`S/tools/drx.mjs:111-231`）

```js
const contrastNormSchema = z.object({
  clips: z.array(z.object({ id, png, group })), outDir: z.string(),
  heroId: z.union([z.string(), z.number()]).optional(),
  clampGain: z.array(z.number()).length(2).optional(),
  clampOffset: z.array(z.number()).length(2).optional(),
});

const rectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

const wbMatchSchema = z.object({
  clips: z.array(z.object({ id, png, group: z.string().optional(), rect: rectSchema.optional() })),
  outDir: z.string(),
  rect: rectSchema.optional(),                       // default neutral patch, fractions 0..1
  mode: z.enum(['neutralize', 'hero']).optional(),
  heroId: z.union([z.string(), z.number()]).optional(),
  clampGain: z.array(z.number()).length(2).optional(),
});

const gamutLegalSchema = z.object({
  clips: z.array(z.object({ id, png })).describe('display-referred'),
  low: z.number().optional(),                        // default 16
  high: z.number().optional(),                       // default 235
  maxIllegalPct: z.number().optional(),              // default 1.0
});

const scopeReadSchema = z.object({
  png: z.string().describe('Display-referred PNG (Rec.709/sRGB)'),
  rect: rectSchema.optional().describe('Optional measurement region (fractions 0..1)'),
  satBins: z.number().optional(),                    // default 16
});

const verifyGradeSchema = z.object({
  intended: gradeRefSchema.describe('The intended .drx'),
  applied: gradeRefSchema.describe('The applied grade read back from Resolve'),
  tol: z.number().optional(),                        // default 1e-3
});

const extractFramesSchema = z.object({
  clips: z.array(z.object({ id, source, at: z.union([z.string(), z.number()]).optional(),
                            proxy: z.string().optional(), displayReferred: z.boolean().optional() })),
  outDir: z.string(),
  displayReferred: z.boolean().optional(),
});

const intentTagsSchema = z.object({
  png: z.string(),
  rect: rectSchema.optional(),
  meta: z.object({}).passthrough().optional(),       // whiteBalanceK/tint/timeOfDay/gel/iso
});
```

## 3. `parse` / `generate` / `merge` / `export_cdl` schema（`S/tools/drx.mjs:233-304`）

```js
const parseSchema = z.object({
  drxPath: z.string().optional(),
  content: z.string().optional(),
}).refine((a) => a.drxPath || a.content, { message: 'provide drxPath or content' });

const generateSchema = z.object({
  gradeParams: z.object({}).passthrough().describe(/* space:'ui'|'drx' ... */),
  metadata: z.object({}).passthrough().optional(),   // { label, width, height }
  target: z.enum(['clip', 'timeline']).optional(),   // default 'clip'
  resolveVersion: z.union([z.number().int().min(1), z.string()]).optional(),
  outputPath: z.string().optional(),
});

const mergeSchema = z.object({
  basePath: z.string().optional(),
  baseContent: z.string().optional(),
  newNodes: z.array(z.object({}).passthrough()).describe(
    "Each: { label?, params: {lift,gamma,gain,offset,saturation,...} } — or put grade keys at the top level. Supports space:'ui'|'drx'"
  ),
  metadata: z.object({}).passthrough().optional(),
  outputPath: z.string().optional(),
}).refine((a) => a.basePath || a.baseContent, { message: 'provide basePath or baseContent' });

const exportCdlSchema = z.object({
  drxPath: z.string().optional(), content: z.string().optional(),
  params: z.object({}).passthrough().optional(),
  format: z.enum(['cdl', 'ccc']).optional(),         // default cdl
});
```

> 关键：`gradeParams` 是 `z.object({}).passthrough()` —— **数组会被 zod 拒绝**，所以
> `drx.generate` 只能单节点（对照 §5.3）。

## 4. 分派与返回组装（`S/tools/drx.mjs:687-987`）

```js
async handler({ action, args }) {
  if (action === 'parse') {
    const p = parseSchema.parse(args);
    const xml = await readContent(p.drxPath, p.content);
    const result = await drxParser().parseDRXContent(xml);
    /* … secondary decoders: customCurves / hslCurves / qualifier / powerWindow … */
    const toolBreakdown = drxParser().extractToolBreakdown ? drxParser().extractToolBreakdown(result.nodes) : undefined;
    return { ...result, toolBreakdown, valueFidelity: computeValueFidelity(result.nodes) };
  }                                          // ⚠️ extractToolBreakdown(nodes 数组) 恒返回默认值

  if (action === 'generate') {
    const p = generateSchema.parse(args);
    const warnings = [];
    const metadata = { ...(p.metadata || {}), ...(p.target ? { target: p.target } : {}),
                       ...(p.resolveVersion !== undefined ? { resolveVersion: p.resolveVersion } : {}) };
    const out = await drxGenerator().generateDRX(normalizeGradeParams(p.gradeParams, warnings), metadata);
    const content = typeof out === 'string' ? out : out?.content || out?.drxContent;
    if (p.outputPath && content) { await fs.writeFile(p.outputPath, content);
      return { outputPath: p.outputPath, bytes: Buffer.byteLength(content), ...warn }; }
    return typeof out === 'string' ? { content: out, ...warn } : { ...out, ...warn };
  }

  if (action === 'merge') {
    const p = mergeSchema.parse(args);
    const warnings = [];
    const newNodes = Array.isArray(p.newNodes)
      ? p.newNodes.map((n) => normalizeNewNode(n, warnings)) : p.newNodes;
    const out = p.basePath
      ? await merger.quickMerge(p.basePath, newNodes, p.metadata || {})
      : await merger.mergeFromContent(p.baseContent, newNodes, p.metadata || {});
    /* … outputPath ? {outputPath,bytes} : {content} … */
  }

  if (action === 'skin_match') {
    const p = skinMatchSchema.parse(args);
    const r = await computeSkinMatch(p.clips, { outDir: p.outDir, heroId: p.heroId,
      clampGain: p.clampGain, minSkinFrac: p.minSkinFrac, metric: p.metric });
    return { groups: r.report, warnings: r.warnings, skipped: r.skipped,
             gradeCount: r.grades.length,
             grades: r.grades.map((g) => ({ id: g.id, group: g.group,
               correctionPct: g.correctionPct, skinFracPct: g.skinFracPct, drxPath: g.drxPath })) };
  }

  if (action === 'scope_read') {
    const p = scopeReadSchema.parse(args);
    const r = await scopeRead(p.png, { rect: p.rect, satBins: p.satBins });
    if (!r) throw new Error(`scope_read: unreadable frame '${p.png}' (skip-not-fake)`);
    return r;
  }
  /* … 其余 action 同构 … */
}
```

## 5. 匹配器返回字段差异（同一文件）

```js
// level_clips  : { groups, warnings, gradeCount, grades[{id,group,correctionPct,drxPath}] }        :785-795
// skin_match   : { groups, warnings, skipped, gradeCount, grades[{id,group,correctionPct,skinFracPct,drxPath}] } :797-807
// shot_match   : { scenes, warnings, skipped, gradeCount, grades[{id,scene,mode,correctionPct,drxPath}] }        :809-819
// cdl_io       : { imported, grades, warnings }                                                   :821-826
// white_balance: { groups, warnings, skipped, gradeCount, grades[{id,group,mode,correctionPct,drxPath}] }        :828-838
// grade_transfer:{ outPath, nodeCount, bodyBytes, label, source }                                 :840-847
// relayout     : { outPath|content, nodeCount, positionsBefore, positions, layout }               :849-877
// contrast_norm: { groups, warnings, skipped, gradeCount, grades[{id,group,correctionPct,drxPath}] } :879-889
// lut_apply    : { lutPath, slotMeta, nodeIndex, verified, liveConfirm, outPath|bytes }           :891-896
// author_look  : manifest {name,version,approvedBy,sourceHash,drxPath,nodeCount,bodyBytes,label}  :898-905
// carry_look   : { look, targetCount, plan, gate }                                               :907-910
// tone_curve   : { report, warnings, skipped, gradeCount, grades[{id,maxDeltaPct,points,drxPath}] } :912-922
// match_to_ref : { report, warnings, skipped, gradeCount, grades[{id,correctionPct,skinGated,lumaPreserve,drxPath}] } :924-941
// saturation   : { report, warnings, skipped, gradeCount, grades[{id,satScale,correctionPct,drxPath}] } :943-947
// black_balance: { report, warnings, skipped, gradeCount, grades[{id,castSpreadPct,drxPath}] }     :949-953
// scope_read   : scopeRead() 原样返回                                                             :955-960
// verify_grade : verifyGrade() 原样返回                                                           :962-965
// extract_frames:{ frames, skipped, warnings }                                                    :967-970
// intent_tags  : { tags, signals, note }                                                          :972-978
// gamut_legal  : { clips: report, warnings, skipped }                                             :980-984
```
