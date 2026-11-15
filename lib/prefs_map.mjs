/**
 * 偏好设置项的平台映射：macOS 与 Windows 的开关名称/存在性不同，必须分开处理。
 * 每一项独立上报状态：ok / not_found / not_applicable / failed，互不牵连。
 */
export const PREFS_SCHEMA = Object.freeze({
  darwin: [
    {
      key: 'displayColorProfile',
      label: '为检视器使用Mac显示色彩描述文件',
      alternates: ['Use Mac Display Color Profiles for Viewers'],
      target: false,
      note: '开启时检视器按系统 ICC（常见 Display P3）解释，预览可能与交付不一致',
    },
    {
      key: 'tag709a',
      label: '自动为Rec.709',
      alternates: ['Automatically tag Rec.709 clips as Rec.709-A'],
      target: true,
      note: 'Apple/QuickTime 链路需要 Rec.709-A 标记；仅 Apple 预览需要，非 Apple 交付可关',
    },
  ],
  win32: [
    {
      key: 'displayColorProfile',
      label: '为检视器使用Windows显示色彩描述文件',
      alternates: ['Use Windows display color profiles for viewers', '配色'],
      target: false,
      applicable: false,
      note: 'Windows 版 Resolve 一般没有这一项（或名称不同）；找不到就报 not_applicable，不要当失败',
    },
    {
      key: 'tag709a',
      label: '自动为Rec.709',
      alternates: ['Automatically tag Rec.709 clips as Rec.709-A'],
      target: true,
      note: '与 macOS 同名项，但部分 Windows 版本没有；找不到报 not_found',
    },
    {
      key: 'displayColorProfileAlt',
      label: '色彩描述文件',
      alternates: ['Color profile', 'ICC'],
      target: false,
      applicable: false,
      note: 'Windows 若以 ICC 方式管理显示器，需按驱动/系统设置单独处理，Resolve 内无同名开关',
    },
  ],
})

export function prefsForPlatform(platform = process.platform) {
  return PREFS_SCHEMA[platform] ?? PREFS_SCHEMA.win32
}
