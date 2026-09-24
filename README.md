# NEU Schedule PWA

一个纯静态、离线优先、无依赖的个人课表 PWA。

## 已彅入

- 课程数据：来自 `WakeUp课程表_研究生选课.csv`
- 班级字段：已在数据模型中保留为 `className`，当前全部为空
- 教学周：按实际教学周校准，2026-09-24 为第 4 周，因此 2026-08-31（周一）为第 1 周
- 健身房：来自 2026-09-04 动态更新的“健身房可用时段”照片

## 使用

直接打开 GitHub Pages 地址即可。iPhone Safari 中可“添加到主屏幕”，之后支持离线启动。

## 修改数据

只需要编辑 `data.js`。课程、节次、班级和健身房时段都集中在那里。

## Pages

仓库内已包含 `.github/workflows/pages.yml`。GitHub Pages 的 Source 设为 **GitHub Actions** 后，每次推送到 `main` 自动发布。
