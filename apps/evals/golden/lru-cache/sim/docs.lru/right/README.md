# cache

## LRU

`new LRU(capacity)` keeps the most recently used entries. `get` counts as a use; `set` evicts the least recently used entry when full.
