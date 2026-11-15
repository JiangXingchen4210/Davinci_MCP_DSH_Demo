/**
 * 擦除策略：**大块物体**（人、车、大件道具）和**小型物体**（钢丝、细线、小道具）走两条不同的流水线，
 * 并且让用户（或自动推荐）在两种擦除方式之间选择：
 *   · plate  —— 干净板：从剪辑点前后取干净帧，配准后拼板，再用 matte 把板盖到目标上
 *   · follow —— 遮罩跟随：逐帧跟踪目标框，只在框内用「时域邻帧」的干净像素替换（钢丝/小物体）
 */

export const ERASE_SIZES = Object.freeze(['large', 'small'])
export const ERASE_METHODS = Object.freeze(['plate', 'follow', 'fullframe'])

/** 按框面积占比 + 长短边比判断大块/小块（阈值来自钢丝/人物实测）。 */
export function classifyEraseTarget({ box, frameWidth = 1920, frameHeight = 1012 } = {}) {
  if (!box) throw new Error('classifyEraseTarget 需要 box')
  const frameArea = frameWidth * frameHeight
  const area = Math.max(1, Number(box.w)) * Math.max(1, Number(box.h))
  const areaPct = (area / frameArea) * 100
  const aspect = Math.max(Number(box.w), Number(box.h)) / Math.max(1, Math.min(Number(box.w), Number(box.h)))
  // 小目标：面积 < 1.5%，或明显细长（aspect ≥ 6 的钢丝/线缆）
  const small = areaPct < 1.5 || aspect >= 6
  return {
    kind: small ? 'small' : 'large',
    areaPct: Number(areaPct.toFixed(3)),
    aspect: Number(aspect.toFixed(2)),
    reason: small
      ? `目标只占画面的 ${areaPct.toFixed(2)}%（细长比 ${aspect.toFixed(1)}）→ 按小物体处理`
      : `目标占画面 ${areaPct.toFixed(2)}% → 按大物体处理`,
  }
}

/**
 * 生成擦除方案。返回可执行的步骤与推荐方式，不直接改 Resolve。
 * @param {{box:{x:number,y:number,w:number,h:number}, frameWidth?:number, frameHeight?:number,
 *          size?:'large'|'small'|'auto', method?:'plate'|'follow'|'auto', fps?:number, durationSec?:number,
 *          hasCleanFrames?:boolean}} options
 */
export function planErase(options = {}) {
  const { box, frameWidth = 1920, frameHeight = 1012, fps = 24, durationSec = 6 } = options
  const cls = classifyEraseTarget({ box, frameWidth, frameHeight })
  const size = options.size && options.size !== 'auto' ? options.size : cls.kind
  const method = options.method && options.method !== 'auto'
    ? options.method
    : size === 'large'
      ? 'plate'
      : 'follow'

  if (method === 'fullframe') {
    const steps = [
      '① 干净板按帧做 ECC 配准（消除手持微动、山脊错位）',
      '② 逐帧与板做**全帧**逐像素比对，差异超阈值整块替换（不依赖人物 matte）',
      '③ 保护框内不替换（默认框住右侧演员，避免误擦）',
      '④ Fusion 合成：MediaIn + ErasePlate(RGBA 序列) → Merge → MediaOut',
    ]
    return {
      ok: true, size, method, classification: cls, steps,
      warnings: ['全帧比对会把所有与板不一致的像素替换掉；保护框必须覆盖画面里其他要保留的移动物体'],
      frames: Math.round(durationSec * fps),
      recommended: { size: 'large', method: 'fullframe' },
      note: '只叠加合成，不生成替换源媒体的文件',
    }
  }
  const steps = []
  const warnings = []
  if (size === 'large') {
    steps.push('① 从剪辑点前后取干净帧（至少 8 张），用 ECC 仿射对齐后取逐像素中位数 → 干净板')
    steps.push('② 逐帧生成目标 matte（人物用 Apple Vision 人物分割；其他大件用框跟踪）')
    if (method === 'plate') {
      steps.push('③ 把干净板按 matte 的 alpha 逐帧合成进 Fusion（原素材不动）')
      warnings.push('大物体+干净板：目标长时间挡住同一块背景时，板里会缺样本，需要更多前后帧或接受轻微修补')
    } else {
      steps.push('③ 逐帧跟踪框内用「时域前后最近干净帧」替换（不用整块板）')
      warnings.push('大物体+遮罩跟随：目标移动慢时，前后帧也可能被他挡住，命中率低')
    }
    steps.push('④ 用 Fusion 合成：MediaIn + ErasePlate(Loader RGBA 序列) → Merge → MediaOut')
  } else {
    steps.push('① 逐帧跟踪小目标框（Vision trackBox，细长目标会自动加长边留白）')
    steps.push('② 在框内取「前后各 2~3 帧的中位数」作为补丁（细线/钢丝几乎不会同时挡住同一像素）')
    if (method === 'follow') {
      steps.push('③ 逐帧只在跟踪框内做羽化替换 → Fusion 里用 matte 序列合成')
    } else {
      steps.push('③ 若整段目标位置固定，可用单张干净板一次盖住（省节点）')
      warnings.push('小物体+干净板：目标若有位移，单板会露出残影')
    }
    steps.push('④ Fusion 合成：MediaIn + Patch(Loader RGBA 序列) → Merge → MediaOut')
  }

  return {
    ok: true,
    size,
    method,
    classification: cls,
    steps,
    warnings,
    frames: Math.round(durationSec * fps),
    recommended: { size: cls.kind, method: cls.kind === 'large' ? 'plate' : 'follow' },
    note: '两种方式都只做「叠加」合成，不生成替换源媒体的文件',
  }
}
