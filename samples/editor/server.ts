import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

// A deliberately small, generic target. No mocks: the browser operates a real
// HTTP page and localStorage. The cancel bug can be toggled by the test host.
export async function startSample(port = 4320) {
  let fixed = process.env.SAMPLE_FIXED === "1";
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === "/next") {
      res.end('<h1>다음 화면</h1><a href="/">돌아가기</a>');
      return;
    }
    res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>작은 메모장</title>
      <style>body{font:17px system-ui;max-width:680px;margin:64px auto;padding:24px;color:#253a34}label{display:block;margin:20px 0}input,select,button{font:inherit;padding:10px}button{margin-right:10px}#saved{padding:20px;background:#eef4f0}canvas{border:1px solid #999}</style>
      <h1>작은 메모장</h1><p>취소하면 저장된 제목이 그대로 남아야 합니다.</p>
      <label>제목 <input id="title" value="처음 제목"></label><button id="save">저장</button><button id="cancel">취소</button>
      <p id="saved" data-testid="saved-title">처음 제목</p><p id="count" data-testid="click-count">0</p><button id="increment">횟수 추가</button>
      <label>공개 <input type="checkbox" id="public"></label><label>분류 <select id="category"><option value="work">업무</option><option value="personal">개인</option></select></label>
      <label>비밀번호 <input type="password" id="password"></label><label>첨부 <input type="file" id="attachment"></label>
      <a href="/next">다음 화면</a> <a href="/next" target="_blank">새 탭</a><p><canvas width="150" height="50"></canvas></p>
      <script>let saved=localStorage.getItem('title')||'처음 제목'; const input=document.querySelector('#title'), output=document.querySelector('#saved'); input.value=saved;output.textContent=saved;
      document.querySelector('#save').onclick=()=>{saved=input.value;localStorage.setItem('title',saved);output.textContent=saved};
      document.querySelector('#cancel').onclick=()=>{${fixed ? "input.value=saved" : "saved=input.value;output.textContent=saved;localStorage.setItem('title',saved)"}};
      let count=0;document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent=String(++count);
      </script></html>`);
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const address = server.address();
  return {
    url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}/`,
    setFixed(value: boolean) {
      fixed = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const sample = await startSample(Number(process.env.PORT || 4320));
  console.log(`Sample: ${sample.url} (SAMPLE_FIXED=1 enables the fix)`);
}
