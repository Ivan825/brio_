export class Stack {
  #items = [];
  push(x) {
    this.#items.push(x);
  }
  pop() {
    return this.#items.pop();
  }
  peek() {
    return this.#items[this.#items.length - 1];
  }
  get size() {
    return this.#items.length;
  }
}
