# Threebody-3D 全面优化与改进方案

> 基于项目代码结构、功能实现、性能表现和用户体验的深度分析，制定的系统性优化计划。

---

## 目录

1. [性能优化](#一性能优化高优先级)
2. [代码质量提升](#二代码质量提升)
3. [安全性加固](#三安全性加固)
4. [功能增强](#四功能增强)
5. [可维护性改进](#五可维护性改进)
6. [实施优先级总表](#六实施优先级总表)

---

## 一、性能优化（高优先级）

### 1.1 消除 `computeCenterOfMass()` 重复计算

**问题位置**: `main.js`

每帧调用 `computeCenterOfMass()` 至少 4-5 次：
- `step()` 中调用（约 L1518）
- `updateDustField()` 中调用（约 L845）
- `updateAutoZoom()` 中调用（约 L1785）
- `updateComMesh()` 中调用（约 L1774）
- `updateFocusFollow()` 退出时调用（约 L1257）

**方案**: 在 `step()` 结束时缓存质心，其他方法直接读取缓存值。

```javascript
// 在 constructor 中添加
this.cachedCom = { x: 0, y: 0, z: 0 };

// step() 末尾添加
this.cachedCom = this.computeCenterOfMass();

// 所有调用处改为读取 this.cachedCom
```

**预期效果**: 每帧减少 3-4 次质心遍历计算。

---

### 1.2 减少 GC 压力 — 消除每帧对象分配

**问题位置**: `main.js`

多处方法每帧创建临时 `THREE.Vector3` / `THREE.Color` 对象：
- `updateBodyLabels()` 每次循环 `new THREE.Vector3`
- `findNearestBody()` 每次循环 `new THREE.Vector3`
- `updateTrailMeshes()` 每次循环 `new THREE.Color`
- `updateFocusFollow()` 多处 `new THREE.Vector3`

**方案**: 预分配复用对象。

```javascript
// 在 constructor 中预分配
this._tmpVec3a = new THREE.Vector3();
this._tmpVec3b = new THREE.Vector3();
this._tmpColor = new THREE.Color();

// 使用时
this._tmpVec3a.set(body.x, body.y, body.z).project(this.camera);
```

**预期效果**: 消除每帧数百次小对象分配，减少 GC 停顿，帧率更平稳。

---

### 1.3 尘埃粒子数据结构优化

**问题位置**: `main.js` L664-672

每个尘埃粒子用普通对象存储速度和噪声偏移，2500 个对象分散在堆中，缓存不友好。

**方案**: 改用 TypedArray 平铺存储。

```javascript
const velX = new Float32Array(count);
const velY = new Float32Array(count);
const velZ = new Float32Array(count);
const noiseOffsets = new Float32Array(count * 4);
```

**预期效果**: 内存连续访问，CPU 缓存命中率高，尘埃更新循环提速 20-40%。

---

### 1.4 背景纹理过大

**问题位置**: `main.js` L382

`eso0932a.JPG` 为 15MB，加载缓慢。

**方案**: 压缩为 WebP 格式，分辨率降至 4096×2048，可从 15MB 降至 ~2MB。

---

### 1.5 物理计算移入 Web Worker

**问题位置**: `main.js` L1511-1561

`step()` 在主线程执行，`speedMultiplier` 高时连续多次迭代会阻塞渲染。

**方案**: 将 N-body 积分逻辑移入 Web Worker，主线程仅负责渲染。

**预期效果**: 高速模拟（50x）时不再掉帧，渲染与物理解耦。

---

## 二、代码质量提升

### 2.1 消除重复的 UI 同步代码

**问题位置**: `main.js` L2887-2943 等

`resetDust`、`resetGravityCage`、`resetAutoRotate`、`resetMouseFollow` 等重置按钮存在大量重复的 DOM 赋值代码，每个 50-80 行。

**方案**: 抽取通用同步函数。

```javascript
function syncUI(mapping) {
  for (const [id, value, formatter] of mapping) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = value;
    if (id.endsWith("Val"))
      el.textContent = formatter ? formatter(value) : value;
  }
}
```

**预期效果**: 减少约 300 行重复代码。

---

### 2.2 重复的 ShaderMaterial 定义

**问题位置**: `main.js` L471-493 和 L1673-1695

trail 的 ShaderMaterial 完全相同，定义了两次。

**方案**: 提取为工厂函数 `createTrailMaterial(baseColor)`。

---

### 2.3 重复的按钮点击反馈动画

**问题位置**: `main.js` L2494-2503 等

多处重置按钮包含相同的绿色闪烁动画。

**方案**: 提取为 `flashButton(btn)` 工具函数。

---

## 三、安全性加固

### 3.1 CDN 依赖风险

**问题位置**: `index.html` L695

依赖 `unpkg.com` 加载 three.js，若 CDN 宕机则页面白屏。

**方案**: 使用本地 node_modules 中的 three.js：

```html
<script type="importmap">
{
  "imports": {
    "three": "./node_modules/three/build/three.module.js",
    "three/addons/": "./node_modules/three/examples/jsm/"
  }
}
</script>
```

---

### 3.2 纹理加载无错误处理

**问题位置**: `main.js` L382, L515

`TextureLoader.load` 无 `onError` 回调，加载失败静默忽略。

**方案**: 添加错误回调，加载失败时使用纯色 fallback。

```javascript
textureLoader.load(path, onSuccess, undefined, (err) => {
  console.error(`纹理加载失败: ${path}`, err);
  material.color.setHex(0xffcc00);
});
```

---

## 四、功能增强

### 4.1 添加能量与角动量实时显示

**问题位置**: `main.js` L204-223

已实现 `calcSystemEnergy3D` 和 `calcSystemAngularMomentum3D`，但未在 UI 中展示。

**方案**: 在控制面板添加能量和角动量显示，每 10 帧更新一次。

---

### 4.2 添加预设场景

**方案**: 添加预设场景下拉菜单：
- 八字形稳定解（Figure-8）
- 拉格朗日 L4/L5 三角构型
- 双星+行星系统
- 随机混沌

---

### 4.3 移动端触摸支持

**问题位置**: `main.js` L1002-1009

事件监听仅针对鼠标，触摸设备无法聚焦天体。

**方案**: 添加 `touchstart`/`touchend` 事件。

---

## 五、可维护性改进

### 5.1 单文件过大

**问题**: `main.js` 2950 行，包含物理引擎、渲染、UI 绑定全部逻辑。

**方案**: 按职责拆分模块：
- `physics.js` — 物理计算
- `renderer.js` — Three.js 场景
- `ui.js` — DOM 事件
- `main.js` — 入口

---

### 5.2 缺少缩进格式

**问题**: 整个 `main.js` 几乎无缩进。

**方案**: 运行 Prettier 格式化。

---

### 5.3 魔法数字提取

**方案**: 提取为顶部配置常量。

---

## 六、实施优先级总表

| 优先级 | 编号 | 优化项 | 实施步骤 | 预期效果 |
|--------|------|--------|----------|----------|
| P0 | 1.1 | 缓存质心 | 在 step() 末尾缓存，替换 4 处调用 | 每帧减少重复计算 |
| P0 | 1.2 | 预分配对象 | 在 constructor 中添加复用对象 | 消除 GC 停顿 |
| P0 | 5.2 | 格式化代码 | `npx prettier --write main.js` | 可读性大幅提升 |
| P1 | 3.1 | CDN→本地 | 修改 importmap 指向 node_modules | 消除外网依赖 |
| P1 | 3.2 | 纹理错误处理 | 添加 onError 回调 | 加载失败有反馈 |
| P1 | 1.4 | 压缩背景图 | 转换为 WebP | 首屏加载快 7x |
| P2 | 2.1 | 提取 UI 同步 | 抽取通用函数 | 减少 300 行重复 |
| P2 | 2.2/2.3 | 提取重复代码 | 工厂函数/工具函数 | 降低维护成本 |
| P2 | 4.1 | 能量显示 | 添加 DOM + 调用现有函数 | 物理可验证性 |
| P3 | 1.3 | 尘埃 TypedArray | 重构数据结构 | 尘埃更新提速 20-40% |
| P3 | 1.5 | Web Worker | 物理线程分离 | 高速不掉帧 |
| P3 | 5.1 | 模块拆分 | 分文件 | 长期可维护性 |
