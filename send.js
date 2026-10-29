// 写真の縮小・送信・再送の部品（ES module）
// ブラウザの機能（createImageBitmap・canvas・crypto など）は関数の中でだけ使う。
// そうしておくと Node から import してもエラーにならず、テストできる。

// 長い辺を maxEdge 以下に縮める。拡大はしない。整数に丸める
export function fitSize(w, h, maxEdge) {
  if (!(Math.max(w, h) > maxEdge)) return { w: Math.round(w), h: Math.round(h) };
  if (w >= h) return { w: Math.round(maxEdge), h: Math.max(1, Math.round((h * maxEdge) / w)) };
  return { w: Math.max(1, Math.round((w * maxEdge) / h)), h: Math.round(maxEdge) };
}

// 画像を読む。createImageBitmap（向きは写真の情報に従う）→ だめなら <img>
async function readImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { src: bmp, w: bmp.width, h: bmp.height, done: () => { if (bmp.close) bmp.close(); } };
    } catch (_) { /* <img> で読み直す */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = document.createElement("img");
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("画像を読めませんでした"));
      img.src = url;
    });
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

// 長い辺 maxEdge の JPEG にして、data: を除いた base64 を返す
export async function resizeImage(file, maxEdge = 1600, quality = 0.82) {
  const image = await readImage(file);
  try {
    const { w, h } = fitSize(image.w, image.h, maxEdge);
    if (!(w > 0 && h > 0)) throw new Error("画像の大きさが分かりませんでした");
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("画像を縮められませんでした");
    ctx.fillStyle = "#fff"; // 透明な部分が黒くならないように
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image.src, 0, 0, w, h);
    const url = canvas.toDataURL("image/jpeg", quality);
    canvas.width = canvas.height = 0; // iPhone のメモリを早めに返す
    const head = "data:image/jpeg;base64,";
    if (typeof url !== "string" || url.indexOf(head) !== 0 || url.length === head.length) throw new Error("画像を JPEG にできませんでした");
    return url.slice(head.length);
  } finally {
    image.done();
  }
}

// 送信 ID。受け取り口はファイル名に先頭8文字を使うので、先頭がばらける作り方にする
export function newSendId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  let rand = "";
  for (let i = 0; i < 16; i++) {
    let n;
    if (c && typeof c.getRandomValues === "function") n = c.getRandomValues(new Uint8Array(1))[0] & 15;
    else n = Math.floor(Math.random() * 16);
    rand += n.toString(16);
  }
  return rand + "-" + Date.now().toString(36);
}

function transient(code, message, cause) {
  const err = new Error(message);
  err.retryable = true;
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

// 受け取り口（GAS の /exec）へ送る。text/plain にするのはプリフライトを避けるため。
// GAS は別の URL へリダイレクトして答えるが、fetch がそのまま追いかける
export function createApi(url, { fetch: fetchFn = globalThis.fetch, timeoutMs = 90000 } = {}) {
  return async function api(body) {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (ctrl) ctrl.abort();
        reject(transient("timeout", "返事が届きませんでした（時間切れ）"));
      }, timeoutMs);
    });
    const exchange = (async () => {
      let res;
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(body),
          signal: ctrl ? ctrl.signal : undefined,
          redirect: "follow",
        });
      } catch (e) {
        throw transient("network", "通信できませんでした", e);
      }
      if (!res || res.ok === false) throw transient("http", "受け取り口がエラーを返しました（HTTP " + (res && res.status) + "）");
      let data;
      try {
        data = await res.json();
      } catch (e) {
        throw transient("response", "受け取り口の返事を読めませんでした", e);
      }
      if (!data || typeof data !== "object" || Array.isArray(data) || (data.ok !== true && data.ok !== false)) {
        throw transient("response", "受け取り口の返事の形が違います");
      }
      if (data.ok) return data;
      if (typeof data.error !== "string" || !data.error) throw transient("response", "受け取り口の返事の形が違います");
      const err = new Error("受け取り口のエラー: " + data.error);
      err.code = data.error;
      err.retryable = data.error === "busy" || data.error === "server";
      throw err;
    })();
    try {
      return await Promise.race([exchange, timedOut]);
    } finally {
      clearTimeout(timer);
      exchange.catch(() => {}); // タイムアウトで先に終わったとき、あとから来る失敗を未処理にしない
    }
  };
}

// 1件ずつ送るキュー。送り直せる失敗は retries 回まで待って送り直し、だめなら failed
export function createQueue({
  send,
  onChange = () => {},
  retries = 2,
  backoffMs = [3000, 8000],
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const list = [];
  let running = false;

  function emit() {
    try { onChange(list.slice()); } catch (e) { console.error(e); } // 画面側の不具合で送信を止めない
  }

  async function runJob(job) {
    for (;;) {
      job.status = "sending";
      job.tries += 1;
      emit();
      try {
        job.result = await send(job);
        delete job.error;
        job.status = "done";
        job.file = null; // 届いたら写真のデータは手放す
        emit();
        return;
      } catch (err) {
        job.error = err;
        if (err && err.retryable && job.tries <= retries) {
          emit();
          const wait = backoffMs.length ? backoffMs[Math.min(job.tries - 1, backoffMs.length - 1)] : 0;
          try { await sleep(wait); } catch (_) { /* 待てなくても送り直す */ }
          continue;
        }
        job.status = "failed";
        emit();
        return;
      }
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const job = list.find((j) => j.status === "waiting");
        if (!job) break;
        await runJob(job);
      }
    } finally {
      running = false;
    }
  }

  // すぐには送り始めない（add / retry の直後は waiting のまま見える）
  function kick() { Promise.resolve().then(pump); }

  return {
    add({ mission, file }) {
      const job = { sendId: newSendId(), mission, file, status: "waiting", tries: 0 };
      list.push(job);
      emit();
      kick();
      return job;
    },
    retry(sendId) {
      const job = list.find((j) => j.sendId === sendId);
      if (!job || job.status !== "failed") return;
      job.status = "waiting";
      job.tries = 0; // 送り直しの回数は数え直す
      delete job.error;
      emit();
      kick();
    },
    jobs() { return list.slice(); },
    busy() { return list.some((j) => j.status === "waiting" || j.status === "sending"); },
  };
}
