/* @flow */

import { isPlainObject, hasOwn } from '../shared/util.js'
import { isReserved } from '../utils.js'


export function initState(vm: Component) {
  // 省略代码...
  const opts = vm.$options;
  if (opts.data) {
    initData(vm);
  } else {
    // $data属性是一个访问器属性，其代理的值就是 vm._data
    observe((vm._data = {}), true /* asRootData */);
  }
	 // 省略代码...
}

function initData(vm: Component) {
	/**
  * S1 确保获取的data是一个纯对象类型:
  * 理论上经过mergeOptions函数处理后，vm.$options.data的返回值一定是一个函数
  * 但是在 mergeOptions-- beforeCreate-- initData流程中，用户可以在beforeCreate()阶* 段修改vm.$options.data值，所以此处还是需要进行保底的类型判断
  */
  let data = vm.$options.data;
  data = vm._data = typeof data === "function" ? getData(data, vm) : data || {};
  if (!isPlainObject(data)) {
    data = {};
    process.env.NODE_ENV !== "production" &&
      warn(
        "data functions should return an object:\n" +
          "https://vuejs.org/v2/guide/components.html#data-Must-Be-a-Function",
        vm
      );
  }
  //S2 遍历对 data中的keyX进行同名校验
  const keys = Object.keys(data);
  const props = vm.$options.props;
  const methods = vm.$options.methods;
  let i = keys.length;
  while (i--) {
    const key = keys[i];
    if (process.env.NODE_ENV !== "production") {
      if (methods && hasOwn(methods, key)) {
        warn(
          `Method "${key}" has already been defined as a data property.`,
          vm
        );
      }
    }
    if (props && hasOwn(props, key)) {
      process.env.NODE_ENV !== "production" &&
        warn(
          `The data property "${key}" is already declared as a prop. ` +
            `Use prop default value instead.`,
          vm
        );
		//S3 代理vm._data属性: 
    } else if (!isReserved(key)) {
      proxy(vm, `_data`, key);
    }
  }
  //S4 observe data
  observe(data, true /* asRootData */);
}

// getData
export function getData (data: Function, vm: Component): any {
  // #7573 disable dep collection when invoking data getters
  pushTarget()
  try {
    return data.call(vm, vm)
  } catch (e) {
    handleError(e, vm, `data()`)
    return {}
  } finally {
    popTarget()
  }
}

// proxy
const sharedPropertyDefinition = {
  enumerable: true,
  configurable: true,
  get: noop,
  set: noop
}
export function proxy (target: Object, sourceKey: string, key: string) {
  sharedPropertyDefinition.get = function proxyGetter () {
    return this[sourceKey][key]
  }
  sharedPropertyDefinition.set = function proxySetter (val) {
    this[sourceKey][key] = val
  }
  Object.defineProperty(target, key, sharedPropertyDefinition)
}


