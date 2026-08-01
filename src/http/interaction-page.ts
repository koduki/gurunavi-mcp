import type { Request, Response } from "express";

export function interactionPageHandler(request: Request, response: Response): void {
  const rawInteractionId = request.params.interactionId;
  const interactionId = Array.isArray(rawInteractionId) ? rawInteractionId[0] : rawInteractionId;
  if (
    interactionId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      interactionId,
    )
  ) {
    response.status(404).type("text/plain").send("Interaction not found");
    return;
  }
  response
    .status(200)
    .setHeader(
      "Content-Security-Policy",
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
    .setHeader("Referrer-Policy", "no-referrer")
    .setHeader("Cache-Control", "no-store")
    .type("html")
    .send(renderInteractionPage(interactionId));
}

function renderInteractionPage(interactionId: string): string {
  const safeId = JSON.stringify(interactionId);
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ぐるなび専用ブラウザ</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    body { margin: 0; background: #111827; color: #f9fafb; }
    header { display: grid; gap: .35rem; padding: .75rem 1rem; background: #1f2937; }
    header strong { color: #fbbf24; }
    #url { color: #9ca3af; font-size: .8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    main { max-width: 1280px; margin: 0 auto; }
    #screen { display: block; width: 100%; height: auto; cursor: crosshair; background: white; }
    .tools { position: sticky; bottom: 0; display: flex; gap: .5rem; flex-wrap: wrap; padding: .75rem; background: #1f2937ee; }
    input { flex: 1 1 18rem; min-width: 8rem; padding: .7rem; border-radius: .4rem; border: 1px solid #4b5563; background: #111827; color: white; }
    button { padding: .65rem .9rem; border: 0; border-radius: .4rem; background: #374151; color: white; cursor: pointer; }
    button.primary { background: #b45309; }
    #status { font-size: .85rem; color: #d1d5db; }
  </style>
</head>
<body>
  <header>
    <strong>ぐるなび専用ブラウザ</strong>
    <span id="status">接続中…</span>
    <span id="url"></span>
  </header>
  <main>
    <img id="screen" alt="操作対象ブラウザ画面" draggable="false">
    <div class="tools">
      <input id="text" type="password" autocomplete="off" placeholder="選択中の欄へ文字を送る（入力後は消去されます）">
      <button id="send">入力</button>
      <button data-key="Tab">Tab</button>
      <button data-key="Enter">Enter</button>
      <button data-scroll="-600">↑</button>
      <button data-scroll="600">↓</button>
      <button id="refresh">再読込</button>
      <button id="finish" class="primary">操作を完了</button>
    </div>
  </main>
  <script>
    const interactionId = ${safeId};
    const token = new URLSearchParams(location.hash.slice(1)).get("token");
    history.replaceState(null, "", location.pathname);
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(scheme + "//" + location.host + "/interactions/" + interactionId + "/ws");
    const screen = document.getElementById("screen");
    const status = document.getElementById("status");
    const url = document.getElementById("url");
    const input = document.getElementById("text");
    const send = value => socket.readyState === 1 && socket.send(JSON.stringify(value));
    socket.onopen = () => {
      if (!token) {
        status.textContent = "接続トークンがありません。新しいURLを発行してください。";
        socket.close();
        return;
      }
      send({ type: "authenticate", token });
    };
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === "frame") {
        screen.src = "data:image/jpeg;base64," + message.image;
        screen.dataset.width = message.width;
        screen.dataset.height = message.height;
        url.textContent = message.title + " — " + message.url;
        status.textContent = "接続済み";
      } else if (message.type === "complete") {
        status.textContent = message.message;
      } else if (message.type === "error") {
        status.textContent = message.message;
      }
    };
    socket.onclose = () => { if (!status.textContent.includes("保存")) status.textContent = "接続が終了しました"; };
    screen.addEventListener("click", event => {
      const rect = screen.getBoundingClientRect();
      send({
        type: "click",
        x: (event.clientX - rect.left) * Number(screen.dataset.width || 1280) / rect.width,
        y: (event.clientY - rect.top) * Number(screen.dataset.height || 800) / rect.height
      });
    });
    document.getElementById("send").onclick = () => {
      send({ type: "text", text: input.value });
      input.value = "";
      input.focus();
    };
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") document.getElementById("send").click();
    });
    document.querySelectorAll("[data-key]").forEach(button => button.onclick = () => send({ type: "key", key: button.dataset.key }));
    document.querySelectorAll("[data-scroll]").forEach(button => button.onclick = () => send({ type: "scroll", delta_y: Number(button.dataset.scroll) }));
    document.getElementById("refresh").onclick = () => send({ type: "refresh" });
    document.getElementById("finish").onclick = () => {
      if (confirm("ログイン・本人確認など必要な操作は完了しましたか？")) send({ type: "finish" });
    };
  </script>
</body>
</html>`;
}
