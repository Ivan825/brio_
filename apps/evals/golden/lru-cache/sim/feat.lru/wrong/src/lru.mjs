export class LRU {
  #map = new Map();
  constructor(capacity) {
    this.capacity = capacity;
  }
  get(key) {
    return this.#map.get(key);
  }
  set(key, value) {
    this.#map.set(key, value);
    if (this.#map.size > this.capacity) this.#map.delete(this.#map.keys().next().value);
  }
}
