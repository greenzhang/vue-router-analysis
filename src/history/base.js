/* @flow */

import { _Vue } from '../install'
import type Router from '../index'
import { inBrowser } from '../util/dom'
import { runQueue } from '../util/async'
import { warn, isError } from '../util/warn'
import { START, isSameRoute } from '../util/route'
import {
  flatten,
  flatMapComponents,
  resolveAsyncComponents
} from '../util/resolve-components'

export class History {
  router: Router;
  base: string;
  current: Route;
  pending: ?Route;
  cb: (r: Route) => void;
  ready: boolean;
  readyCbs: Array<Function>;
  readyErrorCbs: Array<Function>;
  errorCbs: Array<Function>;

  // implemented by sub-classes
  +go: (n: number) => void;
  +push: (loc: RawLocation) => void;
  +replace: (loc: RawLocation) => void;
  +ensureURL: (push?: boolean) => void;
  +getCurrentLocation: () => string;

  constructor (router: Router, base: ?string) {
    // vue router实例
    this.router = router
    // 基路径 调用nomolize方法初始化
    this.base = normalizeBase(base)
    // start with a route object that stands for "nowhere"
    // 当前路由
    this.current = START
    // 阻塞状态
    this.pending = null
    // 是否就绪状态
    this.ready = false
    // 就绪状态的回调数组
    this.readyCbs = []
    // 就绪时产生错误的回调数组
    this.readyErrorCbs = []
    // 错误的回调数组
    this.errorCbs = []
  }
  // 监听路由的变化，并更新实例上的cb属性
  listen (cb: Function) {
    this.cb = cb
  }
  // 接收cb和errorCb两个参数，用于注册ready时的回调
  onReady (cb: Function, errorCb: ?Function) {
    // 如果已经就绪 则执行cb回调
    if (this.ready) {
      cb()
      // 否则将cb放入readyCb的队列中
    } else {
      this.readyCbs.push(cb)
      if (errorCb) {
        this.readyErrorCbs.push(errorCb)
      }
    }
  } 
  // 注册错误回调
  onError (errorCb: Function) {
    // 将错误回调放入到errorCbs队列中
    this.errorCbs.push(errorCb)
  }
  // 路由跳转时调用 接收location(目标位置)/onComplete(完成时回调)/onAbort(终止时回调)
  transitionTo (location: RawLocation, onComplete?: Function, onAbort?: Function) {
    // 拿到当前的路由和location进行匹配，匹配到对应的目标路由后
    const route = this.router.match(location, this.current)
    // 则调用confirmTransition完成真正的跳转操作
    this.confirmTransition(route, () => {
      this.updateRoute(route)
      onComplete && onComplete(route)
      this.ensureURL()

      // fire ready cbs once
      if (!this.ready) {
        this.ready = true
        this.readyCbs.forEach(cb => { cb(route) })
      }
    }, err => {
      if (onAbort) {
        onAbort(err)
      }
      if (err && !this.ready) {
        this.ready = true
        this.readyErrorCbs.forEach(cb => { cb(err) })
      }
    })
  }
  // 真正完成路由跳转的函数，接收route(目标路由)/onComplete(完成时回调)/onAbort(中止时回调)
  confirmTransition (route: Route, onComplete: Function, onAbort?: Function) {
    const current = this.current
    // 先创建abort方法，中止跳转
    const abort = err => {
      if (isError(err)) {
        // 执行errorCbs队列中注册的错误回调
        if (this.errorCbs.length) {
          this.errorCbs.forEach(cb => { cb(err) })
        } else {
          warn(false, 'uncaught error during route navigation:')
          console.error(err)
        }
      }
      // 然后再执行用户调用transitionTo方法传递的错误回调函数
      onAbort && onAbort(err)
    }
    // 先判断跳转路由和目标路由是否是同一个
    if (
      isSameRoute(route, current) &&
      // in the case the route map has been dynamically appended to
      route.matched.length === current.matched.length
    ) {
      this.ensureURL()
      return abort()
    }

    const {
      updated, // 重用组件
      deactivated, // 失活组件
      activated // 激活组件
    } = resolveQueue(this.current.matched, route.matched)
    /**
     * 完整的导航解析流程
     * 1.导航被触发。
     * 2.在失活的组件里调用离开守卫。
     * 3.调用全局的 beforeEach 守卫。
     * 4.在重用的组件里调用 beforeRouteUpdate 守卫 (2.2+)。
     * 5.在路由配置里调用 beforeEnter。
     * 6.解析异步路由组件。
     * 7.在被激活的组件里调用 beforeRouteEnter。
     * 8.调用全局的 beforeResolve 守卫 (2.5+)。
     * 9.导航被确认。
     * 10.调用全局的 afterEach 钩子。
     * 11.触发 DOM 更新。
     * 12.用创建好的实例调用 beforeRouteEnter 守卫中传给 next 的回调函数。
     */
    const queue: Array<?NavigationGuard> = [].concat(
      // in-component leave guards
      // 对应第二步，组件级离开守卫
      extractLeaveGuards(deactivated),
      // global before hooks
      // 对应第三步，全局beforeEach守卫
      this.router.beforeHooks,
      // in-component update hooks
      // 对应第四步，重用的组件里调用beforeRouteUpdate守卫
      extractUpdateHooks(updated),
      // in-config enter guards
      // 对应第五步，路由配置中的beforeEnter守卫
      activated.map(m => m.beforeEnter),
      // async components
      // 对饮第六步，提取异步路由组件守卫
      resolveAsyncComponents(activated)
    )

    this.pending = route
    // 构建迭代器
    const iterator = (hook: NavigationGuard, next) => {
      if (this.pending !== route) {
        return abort()
      }
      try {
        hook(route, current, (to: any) => {
          if (to === false || isError(to)) {
            // next(false) -> abort navigation, ensure current URL
            this.ensureURL(true)
            abort(to)
          } else if (
            typeof to === 'string' ||
            (typeof to === 'object' && (
              typeof to.path === 'string' ||
              typeof to.name === 'string'
            ))
          ) {
            // next('/') or next({ path: '/' }) -> redirect
            abort()
            if (typeof to === 'object' && to.replace) {
              this.replace(to)
            } else {
              this.push(to)
            }
          } else {
            // confirm transition and pass on the value
            next(to)
          }
        })
      } catch (e) {
        abort(e)
      }
    }
    // 遍历queue ，将每种导航守卫作为参数调用iterator
    runQueue(queue, iterator, () => {
      const postEnterCbs = []
      const isVal.id = () => this.current === route
      // wait until async components are resolved before
      // extracting in-component enter guards
      // 等待异步组件 OK 时，执行组件内的钩子

      // 对应第七步，在被激活的组件里调用 beforeRouteEnter 守卫
      const enterGuards = extractEnterGuards(activated, postEnterCbs, isValid)
      // 对应第八步，全局的 beforeResolve 守卫
      const queue = enterGuards.concat(this.router.resolveHooks)
      runQueue(queue, iterator, () => {
        if (this.pending !== route) {
          return abort()
        }
        this.pending = null
        // 在第二次调用runQueue之后，在runQueue回调函数里面执行onComplete方法来
        // 对应第九步，确认导航
        onComplete(route)
        if (this.router.app) {
          // 对应第十一步，调用$nextTick
          this.router.app.$nextTick(() => {
            //对应第十二步，执行beforeRouteEnter守卫中传给next的回调函数
            postEnterCbs.forEach(cb => { cb() })
          })
        }
      })
    })
  }

  updateRoute (route: Route) {
    const prev = this.current
    this.current = route
    this.cb && this.cb(route)
    // 对应第十步，执行全局的afterEach钩子。
    this.router.afterHooks.forEach(hook => {
      hook && hook(route, prev)
    })
  }
}

function normalizeBase (base: ?string): string {
  if (!base) {
    if (inBrowser) {
      // respect <base> tag
      const baseEl = document.querySelector('base')
      base = (baseEl && baseEl.getAttribute('href')) || '/'
      // strip full URL origin
      base = base.replace(/^https?:\/\/[^\/]+/, '')
    } else {
      base = '/'
    }
  }
  // make sure there's the starting slash
  if (base.charAt(0) !== '/') {
    base = '/' + base
  }
  // remove trailing slash
  return base.replace(/\/$/, '')
}

function resolveQueue (
  current: Array<RouteRecord>,
  next: Array<RouteRecord>
): {
  updated: Array<RouteRecord>,
  activated: Array<RouteRecord>,
  deactivated: Array<RouteRecord>
} {
  let i
  const max = Math.max(current.length, next.length)
  for (i = 0; i < max; i++) {
    if (current[i] !== next[i]) {
      break
    }
  }
  return {
    updated: next.slice(0, i),
    activated: next.slice(i),
    deactivated: current.slice(i)
  }
}

function extractGuards (
  records: Array<RouteRecord>,
  name: string,
  bind: Function,
  reverse?: boolean
): Array<?Function> {
  const guards = flatMapComponents(records, (def, instance, match, key) => {
    const guard = extractGuard(def, name)
    if (guard) {
      return Array.isArray(guard)
        ? guard.map(guard => bind(guard, instance, match, key))
        : bind(guard, instance, match, key)
    }
  })
  return flatten(reverse ? guards.reverse() : guards)
}

function extractGuard (
  def: Object | Function,
  key: string
): NavigationGuard | Array<NavigationGuard> {
  if (typeof def !== 'function') {
    // extend now so that global mixins are applied.
    def = _Vue.extend(def)
  }
  return def.options[key]
}

function extractLeaveGuards (deactivated: Array<RouteRecord>): Array<?Function> {
  return extractGuards(deactivated, 'beforeRouteLeave', bindGuard, true)
}

function extractUpdateHooks (updated: Array<RouteRecord>): Array<?Function> {
  return extractGuards(updated, 'beforeRouteUpdate', bindGuard)
}

function bindGuard (guard: NavigationGuard, instance: ?_Vue): ?NavigationGuard {
  if (instance) {
    return function boundRouteGuard () {
      return guard.apply(instance, arguments)
    }
  }
}

function extractEnterGuards (
  activated: Array<RouteRecord>,
  cbs: Array<Function>,
  isValid: () => boolean
): Array<?Function> {
  return extractGuards(activated, 'beforeRouteEnter', (guard, _, match, key) => {
    return bindEnterGuard(guard, match, key, cbs, isValid)
  })
}

function bindEnterGuard (
  guard: NavigationGuard,
  match: RouteRecord,
  key: string,
  cbs: Array<Function>,
  isValid: () => boolean
): NavigationGuard {
  return function routeEnterGuard (to, from, next) {
    return guard(to, from, cb => {
      next(cb)
      if (typeof cb === 'function') {
        cbs.push(() => {
          // #750
          // if a router-view is wrapped with an out-in transition,
          // the instance may not have been registered at this time.
          // we will need to poll for registration until current route
          // is no longer valid.
          poll(cb, match.instances, key, isValid)
        })
      }
    })
  }
}

function poll (
  cb: any, // somehow flow cannot infer this is a function
  instances: Object,
  key: string,
  isValid: () => boolean
) {
  if (instances[key]) {
    cb(instances[key])
  } else if (isValid()) {
    setTimeout(() => {
      poll(cb, instances, key, isValid)
    }, 16)
  }
}
