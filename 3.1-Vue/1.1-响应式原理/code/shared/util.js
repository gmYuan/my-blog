//对应 src/shared/util.js

const _toString = Object.prototype.toString
export function isPlainObject (obj: any): boolean {
  return _toString.call(obj) === '[object Object]'
}

// 可以用来检测一个对象是否含有特定的自身属性；
// 和 in 运算符不同，该方法会忽略掉那些从原型链上继承到的属性
const hasOwnProperty = Object.prototype.hasOwnProperty
export function hasOwn (obj: Object | Array<*>, key: string): boolean {
  return hasOwnProperty.call(obj, key)
}


export function isObject (obj: mixed): boolean %checks {
  return obj !== null && typeof obj === 'object'
}