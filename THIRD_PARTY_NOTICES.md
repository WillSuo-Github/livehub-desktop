# Third-party notices

## DYLIVE

LiveHub's Douyin parser flow and selected data-model ideas were adapted from the Go project `github.com/caiguanhao/dylive`.

- Source: https://github.com/caiguanhao/dylive
- License: MIT
- Copyright: 2022 caiguanhao

The current `native/douyin-helper` does not include DYLIVE as a runtime dependency. This notice remains because the parser flow was adapted from that project.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Streamlink stream-resolution references

`electron/stream-service.ts` adapts the direct-stream resolution flow used by Streamlink's public Douyu, Huya, and Bilibili plugins. LiveHub does not bundle Streamlink or invoke it at runtime.

- Source: https://github.com/streamlink/streamlink
- Douyu plugin: https://github.com/streamlink/streamlink/blob/master/src/streamlink/plugins/douyu.py
- Huya plugin: https://github.com/streamlink/streamlink/blob/master/src/streamlink/plugins/huya.py
- Bilibili plugin: https://github.com/streamlink/streamlink/blob/master/src/streamlink/plugins/bilibili.py
- License: BSD-2-Clause

Copyright (c) 2011-2016, Christopher Rosell
Copyright (c) 2016-2026, Streamlink Team
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Public API references

The Douyu, Huya, and Bilibili adapters use public HTTP endpoints and category/pagination formats. LiveHub does not bundle or copy source code from these references:

- Douyu API reference: https://github.com/birjemin/douyuapi
- Huya public list endpoint notes: https://cloud.tencent.com/developer/article/1856430
- Bilibili live area API reference: https://github.com/MayIHaveK/bili-apis/blob/master/docs/live/live_area.md
