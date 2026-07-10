/**
 * TashUrA Admin Worker
 * GitHub এর products.json এবং banners.json কে manage করে
 * 
 * Cloudflare Dashboard Settings > Environment Variables এ শুধুমাত্র এই ২টি set করবেন:
 *   GITHUB_TOKEN (Secret)    - GitHub Personal Access Token
 *   ADMIN_PASSWORD (Secret)  - Admin panel password
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
};

// Repo Config - সঠিক repo details
const REPO_CONFIG = {
  OWNER: "tashurashopcom-cyber",
  NAME: "Order-Management",
  BRANCH: "main",
  PRODUCTS_FILE: "products.json",
  BANNERS_FILE: "banners.json"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function checkAuth(request, env) {
  const pass = request.headers.get("X-Admin-Password");
  return pass && pass === env.ADMIN_PASSWORD;
}

async function githubGetFile(env, filePath) {
  const url = `https://api.github.com/repos/${REPO_CONFIG.OWNER}/${REPO_CONFIG.NAME}/contents/${filePath}?ref=${REPO_CONFIG.BRANCH}`;
  
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "TashUrA-Admin-Worker",
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`GitHub GET error: ${res.status}`, text);
    throw new Error(`GitHub API error: ${res.status} - ${text}`);
  }

  const data = await res.json();
  
  // Base64 decode
  const binary = atob(data.content.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  
  return { 
    items: JSON.parse(text), 
    sha: data.sha 
  };
}

async function githubPutFile(env, filePath, items, sha, message) {
  const url = `https://api.github.com/repos/${REPO_CONFIG.OWNER}/${REPO_CONFIG.NAME}/contents/${filePath}`;
  
  const jsonText = JSON.stringify(items, null, 2);
  const bytes = new TextEncoder().encode(jsonText);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  const base64Content = btoa(binary);

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "TashUrA-Admin-Worker",
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: base64Content,
      sha,
      branch: REPO_CONFIG.BRANCH,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`GitHub PUT error: ${res.status}`, text);
    throw new Error(`GitHub API error: ${res.status} - ${text}`);
  }

  return res.json();
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      // ---- GET /api/products : সবার জন্য পাবলিক ----
      if (request.method === "GET" && parts[1] === "products") {
        const { items } = await githubGetFile(env, REPO_CONFIG.PRODUCTS_FILE);
        return json({ ok: true, products: items });
      }

      // ---- GET /api/banners : সবার জন্য পাবলিক ----
      if (request.method === "GET" && parts[1] === "banners") {
        const { items } = await githubGetFile(env, REPO_CONFIG.BANNERS_FILE);
        return json({ ok: true, banners: items });
      }

      // ---- POST /api/verify : পাসওয়ার্ড চেক ----
      if (request.method === "POST" && parts[1] === "verify") {
        if (checkAuth(request, env)) {
          return json({ ok: true });
        }
        return json({ ok: false, error: "ভুল পাসওয়ার্ড" }, 401);
      }

      // নিচের সব অ্যাকশন পাসওয়ার্ড প্রয়োজন
      if (!checkAuth(request, env)) {
        return json({ ok: false, error: "অননুমোদিত" }, 401);
      }

      // ---- POST /api/products : নতুন প্রোডাক্ট ----
      if (request.method === "POST" && parts[1] === "products") {
        const newProduct = await request.json();
        if (!newProduct.code) {
          return json({ ok: false, error: "প্রোডাক্ট কোড প্রয়োজন" }, 400);
        }

        const { items, sha } = await githubGetFile(env, REPO_CONFIG.PRODUCTS_FILE);
        
        if (items.some((p) => p.code === newProduct.code)) {
          return json({ ok: false, error: "এই কোডের প্রোডাক্ট আগে থেকেই আছে" }, 400);
        }

        items.push(newProduct);
        await githubPutFile(env, REPO_CONFIG.PRODUCTS_FILE, items, sha, `Add product: ${newProduct.code}`);
        return json({ ok: true, products: items });
      }

      // ---- PUT /api/products/:code : প্রোডাক্ট এডিট ----
      if (request.method === "PUT" && parts[1] === "products" && parts[2]) {
        const code = decodeURIComponent(parts[2]);
        const updates = await request.json();

        const { items, sha } = await githubGetFile(env, REPO_CONFIG.PRODUCTS_FILE);
        const idx = items.findIndex((p) => p.code === code);
        
        if (idx === -1) {
          return json({ ok: false, error: "প্রোডাক্ট পাওয়া যায়নি" }, 404);
        }

        items[idx] = { ...items[idx], ...updates };
        await githubPutFile(env, REPO_CONFIG.PRODUCTS_FILE, items, sha, `Update product: ${code}`);
        return json({ ok: true, products: items });
      }

      // ---- DELETE /api/products/:code ----
      if (request.method === "DELETE" && parts[1] === "products" && parts[2]) {
        const code = decodeURIComponent(parts[2]);

        const { items, sha } = await githubGetFile(env, REPO_CONFIG.PRODUCTS_FILE);
        const filtered = items.filter((p) => p.code !== code);
        
        if (filtered.length === items.length) {
          return json({ ok: false, error: "প্রোডাক্ট পাওয়া যায়নি" }, 404);
        }

        await githubPutFile(env, REPO_CONFIG.PRODUCTS_FILE, filtered, sha, `Delete product: ${code}`);
        return json({ ok: true, products: filtered });
      }

      // ================= ব্যানার রুট =================

      // ---- POST /api/banners : নতুন ব্যানার ----
      if (request.method === "POST" && parts[1] === "banners") {
        const newBanner = await request.json();
        if (!newBanner.image) {
          return json({ ok: false, error: "ব্যানার ইমেজ URL প্রয়োজন" }, 400);
        }

        const { items, sha } = await githubGetFile(env, REPO_CONFIG.BANNERS_FILE);
        const id = "b_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const maxOrder = items.reduce((m, b) => Math.max(m, b.order || 0), 0);

        const banner = {
          id,
          image: newBanner.image,
          link: newBanner.link || "",
          order: newBanner.order ?? maxOrder + 1,
          active: newBanner.active !== undefined ? !!newBanner.active : true,
        };

        items.push(banner);
        await githubPutFile(env, REPO_CONFIG.BANNERS_FILE, items, sha, `Add banner: ${id}`);
        return json({ ok: true, banners: items });
      }

      // ---- PUT /api/banners/:id ----
      if (request.method === "PUT" && parts[1] === "banners" && parts[2]) {
        const id = decodeURIComponent(parts[2]);
        const updates = await request.json();

        const { items, sha } = await githubGetFile(env, REPO_CONFIG.BANNERS_FILE);
        const idx = items.findIndex((b) => b.id === id);
        
        if (idx === -1) {
          return json({ ok: false, error: "ব্যানার পাওয়া যায়নি" }, 404);
        }

        items[idx] = { ...items[idx], ...updates };
        await githubPutFile(env, REPO_CONFIG.BANNERS_FILE, items, sha, `Update banner: ${id}`);
        return json({ ok: true, banners: items });
      }

      // ---- DELETE /api/banners/:id ----
      if (request.method === "DELETE" && parts[1] === "banners" && parts[2]) {
        const id = decodeURIComponent(parts[2]);

        const { items, sha } = await githubGetFile(env, REPO_CONFIG.BANNERS_FILE);
        const filtered = items.filter((b) => b.id !== id);
        
        if (filtered.length === items.length) {
          return json({ ok: false, error: "ব্যানার পাওয়া যায়নি" }, 404);
        }

        await githubPutFile(env, REPO_CONFIG.BANNERS_FILE, filtered, sha, `Delete banner: ${id}`);
        return json({ ok: true, banners: filtered });
      }

      return json({ ok: false, error: "Route পাওয়া যায়নি" }, 404);
    } catch (err) {
      console.error("Worker error:", err);
      return json({ ok: false, error: err.message }, 500);
    }
  },
};
