#!/usr/bin/env bash
# 算法回归测试：
#   1) Python 参考实现（原版小番茄 JS 的直译）生成对照密文
#   2) Node 跑 algo.js，逐字节比对 + 五种模式往返 + 错误参数 + 大图计时
# 依赖：python3 + Pillow、node（前端运行时本身零依赖）
set -euo pipefail
cd "$(dirname "$0")"

rm -rf in out
python3 gen.py in
python3 ref.py in out
node test.js
