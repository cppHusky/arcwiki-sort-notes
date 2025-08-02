# Arcwiki Sort Notes

读入 Songlist 和每个单曲的物理信息，给出每个定级下物理最多和最少的曲目。

给出的内容为 JSON 格式，以便后续编写 Lua 模块。

## Build & Run

Build:

```
$ npm i @types/node axios js-sha256
$ tsc
```

Run:

```
$ node index.js
```
