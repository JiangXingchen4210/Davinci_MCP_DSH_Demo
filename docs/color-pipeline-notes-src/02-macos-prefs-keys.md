# macOS 显示器色彩相关偏好：真实存储位置与键名（实测）

调研机：macOS / DaVinci Resolve Studio 21.0.0b.20。

## 文件位置

```
~/Library/Preferences/Blackmagic Design/DaVinci Resolve/.config.data
~/Library/Preferences/Blackmagic Design/DaVinci Resolve/.config.data.bak
```

- 纯文本 `KEY = VALUE`，一行一个键（不是 plist、不是 XML）。
- `~/Library/Preferences/com.blackmagic-design.DaVinciResolve.plist` 里**没有**这些项（只有窗口/工具栏状态，1466 字节），别去那儿找。
- `config.user.xml` 只有 HDR 调色轮外观等 UI 项（`HDRGradeChromaDisplayType` 等），**也不含** Mac 显示色彩配置开关。

## 与本功能直接相关的两个键（实测原样）

```
EnableDisplayColorProfile = 1
Tag709ClipsAs709A = 0
```

| 键 | 对应 Resolve 界面项 | 实测值 | 含义 |
|---|---|---|---|
| `EnableDisplayColorProfile` | Preferences → System/General → **Use Mac Display Color Profiles for Viewers**（macOS 版） | `1` = 开 | 开启后 Resolve 查看器按 macOS 当前 ICC 配置文件做显示转换；只影响**查看器外观**，不影响渲染 |
| `Tag709ClipsAs709A` | Preferences → 通用 → **Automatically tag Rec.709 clips as Rec.709-A** | `0` = 关 | 开启后，Rec.709 素材在导入时被打上 Rec.709-A 标签（Apple/QuickTime 兼容链路）。BMD 16.2.2 发行说明里的原话是 “Preference to automatically tag Rec.709 clips as Rec.709-A” |

同文件里另有 `System.Scripting.Mode = 1`（脚本开关）、`UseFloatGLPixelFormat = 1`、`UseHwAccForDecodeEnable = 1` 等，与色彩无关，仅供确认文件格式。

## 结论（写进契约的硬事实）

1. 这两个开关**不在** Resolve 脚本 API 里：`Resolve` 对象没有 UIManager/Preferences 读写方法，`Project.GetSetting`/`SetSetting` 也不含这两个键（实测 约 160 键全量快照里没有）。
2. 可以在**只读**前提下从 `.config.data` 读出它们的值，用来做「是否可能受 Mac 显示配置影响」的提示；**不要写这个文件**（Resolve 自己持有并会重写，格式/权限脆弱，改动需重启 Resolve 才生效，写坏会让 Preferences 丢失）。
3. Resolve 21.0.0 上 `Resolve.GetUserPreferencesPresetList / LoadUserPreferencesPreset / SaveUserPreferencesPreset …`（21.0.4+ 才有）全部不可用，实测 `resolve_control get_version` 的 `build.unavailable_on_this_build` 列表里明确列出。也就是说：连「用偏好预设曲线救国」在 21.0.0 上都不成立。
4. 因此 UI 文案必须写：**这两项只能人工在 Resolve 偏好设置里改，插件只能提示，不能代改、不能验证改后状态（除非再读一次该文件，且那只是 Resolve 的落盘值、不是运行中生效值的权威证据）。**
