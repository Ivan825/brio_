export class Stack {
  #items = [];
  push(x) {
    this.#items.push(x);
  }
  pop() {
    return this.#items.pop();
  }
}
