// jsdom has no `AnimationEvent`, and jsdom 31's CSSStyleDeclaration (unlike
// jsdom 25's) reports the prefixed `WebkitAnimation` property. React DOM
// decides which DOM event backs `onAnimationEnd` once, when it loads: with no
// `AnimationEvent` it drops the unprefixed name and, seeing `WebkitAnimation`,
// listens for `webkitAnimationEnd` instead. Every `animationend` a spec
// dispatches then misses React's handler, which no browser this app ships to
// would do (they all expose `AnimationEvent`). Defining the constructor
// restores the browser shape, so React keeps listening for `animationend`.
//
// This module must be imported BEFORE anything that loads react-dom (the
// setup file imports @testing-library/react), because React reads `window`
// once at module evaluation.
if (typeof window !== 'undefined' && !('AnimationEvent' in window)) {
  class AnimationEvent extends Event {
    readonly animationName: string;
    readonly elapsedTime: number;
    readonly pseudoElement: string;

    constructor(type: string, init: AnimationEventInit = {}) {
      super(type, init);
      this.animationName = init.animationName ?? '';
      this.elapsedTime = init.elapsedTime ?? 0;
      this.pseudoElement = init.pseudoElement ?? '';
    }
  }
  Object.defineProperty(window, 'AnimationEvent', { configurable: true, writable: true, value: AnimationEvent });
}

export {};
