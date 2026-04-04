// 对应 src/core/utils/lang.js


export function isReserved (str: string): boolean {
    const c = (str + '').charCodeAt(0)
    return c === 0x24 || c === 0x5F
  }