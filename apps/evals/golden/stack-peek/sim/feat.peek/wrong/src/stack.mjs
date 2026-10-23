export class Stack {
  #items = [];
  push(x) {
    this.#items.push(x);
  }
  pop() {
    return this.#items.pop();
  }
  peek() {
    return this.#items.at(-1);
  }
}
