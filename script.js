/* Démarches Automobile — client web Supabase.
   Renseigner uniquement l'URL du projet et la clé publishable/anon publique.
   Ne jamais mettre une clé service_role dans ce fichier. */
const SUPABASE_URL = "REMPLACER_PAR_URL_SUPABASE";
const SUPABASE_ANON_KEY = "REMPLACER_PAR_CLE_PUBLISHABLE_OU_ANON";

const CONFIGURED = SUPABASE_URL.startsWith("https://") &&
  !SUPABASE_URL.includes("REMPLACER") &&
  SUPABASE_ANON_KEY.length > 20 &&
  !SUPABASE_ANON_KEY.includes("REMPLACER");

const $ = (id) => document.getElementById(id);
let supabaseClient = null;
let authMode = "login";
let currentUser = null;
let isAdmin = false;

document.addEventListener("DOMContentLoaded", async () => {
  $("current-year").textContent = new Date().getFullYear();
  bindUI();
  if (!CONFIGURED || !window.supabase) {
    $("setup-warning").classList.remove("hidden");
    $("auth-message").textContent = "Connexion non configurée. Consultez le guide README.";
    $("auth-message").className = "form-message error full";
    return;
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: { session } } = await supabaseClient.auth.getSession();
  await handleSession(session);
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    // Différer les opérations Supabase hors du callback auth pour éviter les blocages.
    setTimeout(() => handleSession(session), 0);
  });
});

function bindUI() {
  document.querySelectorAll("[data-auth-mode]").forEach(button => {
    button.addEventListener("click", () => {
      authMode = button.dataset.authMode;
      document.querySelectorAll("[data-auth-mode]").forEach(b => b.classList.toggle("active", b === button));
      $("auth-submit").textContent = authMode === "login" ? "Se connecter" : "Créer mon compte";
      $("auth-hint").textContent = authMode === "login"
        ? "Connectez-vous pour accéder à vos dossiers."
        : "Utilisez une adresse e-mail à laquelle vous avez accès. Une confirmation peut être nécessaire.";
      clearMessage("auth-message");
    });
  });
  $("auth-form").addEventListener("submit", submitAuth);
  $("logout-button").addEventListener("click", async () => {
    if (!supabaseClient) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) showMessage("auth-message", error.message, true);
  });
  $("request-form").addEventListener("submit", submitRequest);
  $("refresh-button").addEventListener("click", loadRequests);
}

async function submitAuth(event) {
  event.preventDefault();
  if (!supabaseClient) return;
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  setBusy("auth-submit", true);
  clearMessage("auth-message");
  try {
    let result;
    if (authMode === "signup") {
      result = await supabaseClient.auth.signUp({ email, password });
      if (!result.error && !result.data.session) {
        showMessage("auth-message", "Compte créé. Consultez votre e-mail pour confirmer l’inscription, puis connectez-vous.", false);
      }
    } else {
      result = await supabaseClient.auth.signInWithPassword({ email, password });
    }
    if (result.error) throw result.error;
    if (authMode === "login" && result.data.session) {
      showMessage("auth-message", "Connexion réussie.", false);
    }
  } catch (error) {
    showMessage("auth-message", friendlyError(error), true);
  } finally {
    setBusy("auth-submit", false);
  }
}

async function handleSession(session) {
  currentUser = session?.user || null;
  $("auth-panel").classList.toggle("hidden", !!currentUser);
  $("client-panel").classList.toggle("hidden", !currentUser);
  $("admin-panel").classList.add("hidden");
  if (!currentUser) {
    isAdmin = false;
    return;
  }
  $("welcome-email").textContent = currentUser.email || "Compte client";
  await checkAdmin();
  await loadRequests();
  if (isAdmin) {
    $("admin-panel").classList.remove("hidden");
    await loadAdminRequests();
  }
}

async function checkAdmin() {
  isAdmin = false;
  const { data, error } = await supabaseClient
    .from("user_roles").select("role").eq("user_id", currentUser.id).eq("role", "admin").maybeSingle();
  if (!error && data?.role === "admin") isAdmin = true;
}

async function submitRequest(event) {
  event.preventDefault();
  if (!currentUser || !supabaseClient) return;
  const files = Array.from($("request-files").files || []);
  const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];
  for (const file of files) {
    if (file.size > 5 * 1024 * 1024) {
      showMessage("request-message", `Le fichier « ${file.name} » dépasse 5 Mo.`, true);
      return;
    }
    if (!allowedTypes.includes(file.type)) {
      showMessage("request-message", `Format non accepté : ${file.name}. Utilisez PDF, JPG ou PNG.`, true);
      return;
    }
  }
  const payload = {
    user_id: currentUser.id,
    service_type: $("service-type").value,
    client_name: $("client-name").value.trim(),
    phone: $("client-phone").value.trim(),
    vehicle_registration: $("vehicle-registration").value.trim() || null,
    details: $("request-details").value.trim(),
    status: "Reçue"
  };
  setBusy("request-form", true);
  clearMessage("request-message");
  try {
    const { data, error } = await supabaseClient.from("requests").insert(payload).select("id").single();
    if (error) throw error;
    const requestId = data.id;
    const uploadedPaths = [];
    for (const file of files) {
      const safeName = file.name.normalize("NFKD").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
      const path = `${currentUser.id}/${requestId}/${Date.now()}-${safeName}`;
      const { error: uploadError } = await supabaseClient.storage.from("client-documents").upload(path, file, {
        cacheControl: "3600", upsert: false, contentType: file.type
      });
      if (uploadError) throw uploadError;
      uploadedPaths.push(path);
    }
    if (uploadedPaths.length) {
      const { error: updateError } = await supabaseClient.from("requests")
        .update({ document_paths: uploadedPaths }).eq("id", requestId).eq("user_id", currentUser.id);
      if (updateError) throw updateError;
    }
    $("request-form").reset();
    showMessage("request-message", "Demande enregistrée. Vous la retrouverez dans « Mes dossiers ».", false);
    await loadRequests();
    if (isAdmin) await loadAdminRequests();
  } catch (error) {
    showMessage("request-message", "La demande ou l’envoi des documents a rencontré un problème : " + friendlyError(error) + " Vérifiez votre connexion et contactez l’administrateur avant de renvoyer plusieurs fois.", true);
  } finally {
    setBusy("request-form", false);
  }
}

async function loadRequests() {
  if (!currentUser) return;
  $("request-list").innerHTML = '<p class="muted">Chargement…</p>';
  const query = supabaseClient.from("requests")
    .select("id,service_type,client_name,vehicle_registration,details,status,created_at,document_paths")
    .order("created_at", { ascending: false }).limit(50);
  const { data, error } = await query;
  if (error) {
    $("request-list").innerHTML = '<p class="form-message error">Impossible de charger les dossiers. Vérifiez les règles de sécurité de la base de données.</p>';
    return;
  }
  renderRequests($("request-list"), data || [], false);
}

async function loadAdminRequests() {
  if (!isAdmin) return;
  $("admin-list").innerHTML = '<p class="muted">Chargement…</p>';
  const { data, error } = await supabaseClient.from("requests")
    .select("id,service_type,client_name,phone,vehicle_registration,details,status,created_at,document_paths,user_id")
    .order("created_at", { ascending: false }).limit(100);
  if (error) {
    $("admin-list").innerHTML = '<p class="form-message error">Lecture administrateur impossible. Vérifiez les politiques RLS.</p>';
    return;
  }
  renderRequests($("admin-list"), data || [], true);
}

function renderRequests(container, requests, adminView) {
  if (!requests.length) {
    container.innerHTML = '<p class="muted">Aucun dossier pour le moment.</p>';
    return;
  }
  container.replaceChildren();
  requests.forEach(request => {
    const article = document.createElement("article");
    article.className = "request-item";
    const top = document.createElement("div"); top.className = "request-top";
    const left = document.createElement("div");
    const title = document.createElement("h4"); title.textContent = request.service_type;
    const meta = document.createElement("div"); meta.className = "request-meta";
    meta.textContent = `Dossier ${request.id.slice(0, 8).toUpperCase()} · ${new Date(request.created_at).toLocaleDateString("fr-FR")}`;
    left.append(title, meta);
    const status = document.createElement("span");
    status.className = "status " + statusClass(request.status); status.textContent = request.status;
    top.append(left, status); article.append(top);
    if (adminView) {
      const customer = document.createElement("p"); customer.className = "request-meta";
      customer.textContent = `${request.client_name} · ${request.phone || "Téléphone non renseigné"} · ${request.vehicle_registration || "Sans immatriculation"}`;
      article.append(customer);
    } else if (request.vehicle_registration) {
      const vehicle = document.createElement("p"); vehicle.className = "request-meta"; vehicle.textContent = `Immatriculation : ${request.vehicle_registration}`; article.append(vehicle);
    }
    const details = document.createElement("p"); details.className = "request-details"; details.textContent = request.details || "";
    article.append(details);
    if (request.document_paths?.length) {
      const files = document.createElement("div"); files.className = "file-list"; files.textContent = "Documents : ";
      request.document_paths.forEach((path, index) => {
        if (index) files.append(" · ");
        const link = document.createElement("a"); link.href = "#"; link.textContent = `Fichier ${index + 1}`;
        link.addEventListener("click", async (event) => {
          event.preventDefault();
          const { data, error } = await supabaseClient.storage.from("client-documents").createSignedUrl(path, 60);
          if (error || !data?.signedUrl) { toast("Impossible d’ouvrir ce document."); return; }
          window.open(data.signedUrl, "_blank", "noopener");
        });
        files.append(link);
      });
      article.append(files);
    }
    if (adminView) {
      const row = document.createElement("div"); row.className = "admin-row";
      const info = document.createElement("p"); info.className = "request-meta"; info.textContent = `ID : ${request.id}`;
      const select = document.createElement("select");
      ["Reçue","En cours","Documents manquants","Terminée","Refusée"].forEach(value => {
        const option = document.createElement("option"); option.value = value; option.textContent = value; option.selected = value === request.status; select.append(option);
      });
      const save = document.createElement("button"); save.type = "button"; save.className = "button button-outline button-small"; save.textContent = "Mettre à jour";
      save.addEventListener("click", async () => {
        save.disabled = true;
        const { error } = await supabaseClient.from("requests").update({ status: select.value }).eq("id", request.id);
        save.disabled = false;
        if (error) { toast("Mise à jour impossible. Vérifiez les droits administrateur."); return; }
        toast("Statut mis à jour."); await loadAdminRequests(); await loadRequests();
      });
      row.append(info, select, save); article.append(row);
    }
    container.append(article);
  });
}
function statusClass(status) {
  if (status === "En cours") return "status-en-cours";
  if (status === "Documents manquants") return "status-documents-manquants";
  if (status === "Terminée") return "status-terminee";
  if (status === "Refusée") return "status-refusee";
  return "";
}
function showMessage(id, message, isError) {
  const element = $(id); element.textContent = message;
  element.className = "form-message full " + (isError ? "error" : "success");
}
function clearMessage(id) { const element = $(id); element.textContent = ""; element.className = "form-message full"; }
function setBusy(id, busy) {
  const element = $(id);
  if (element.tagName === "FORM") element.querySelectorAll("button[type=submit]").forEach(b => b.disabled = busy);
  else element.disabled = busy;
}
function friendlyError(error) {
  const message = String(error?.message || error || "Erreur inconnue");
  if (/Invalid login credentials/i.test(message)) return "Adresse e-mail ou mot de passe incorrect.";
  if (/Email not confirmed/i.test(message)) return "Confirmez d’abord votre adresse e-mail.";
  if (/row-level security|permission denied|not allowed/i.test(message)) return "Accès refusé par les règles de sécurité. La configuration doit être vérifiée.";
  return message.slice(0, 240);
}
function toast(message) {
  const element = $("toast"); element.textContent = message; element.classList.remove("hidden");
  window.setTimeout(() => element.classList.add("hidden"), 4000);
}
