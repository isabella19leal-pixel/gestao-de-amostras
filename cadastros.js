// =====================================================================
// GESTÃO DE AMOSTRAS SOND — Cadastros (Etapa 4)
// =====================================================================
// Tela para cadastrar Bases, vínculos OS→Contrato, Contrato→Base e
// Fretes, sem precisar mexer direto nas tabelas do Supabase.
//
// REGRA DE VIGÊNCIA (os_contrato e contrato_base):
// Essas duas tabelas guardam HISTÓRICO — uma OS ou um Contrato pode
// trocar de contrato/base ao longo do tempo, mas nunca perde o vínculo
// anterior. O banco tem uma trava (exclusion constraint) que impede
// duas vigências ativas sobrepostas para a mesma OS/Contrato.
//
// Por isso, ao cadastrar um novo vínculo para uma OS/Contrato que já
// tem um vínculo ativo, esta tela decide automaticamente:
//   - se o vínculo atual foi criado HOJE: corrige a mesma linha (evita
//     lotar o histórico de trocas feitas no mesmo dia por engano/ajuste);
//   - se foi criado em outro dia: encerra a vigência antiga (data_fim =
//     ontem) e cria uma nova vigência a partir de hoje, preservando o
//     histórico.
// Essa lógica foi testada à parte contra o schema real antes da entrega.
// =====================================================================

const STATUS_FRETE = ["AGUARDANDO_CONTRATACAO","CONTRATADO","AGUARDANDO_COLETA","EM_TRANSITO","CHEGOU_SAO_PEDRO","FINALIZADO","ATRASADO"];

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }
function hoje() { return new Date().toISOString().slice(0, 10); }

let currentUser = null;
let isAdmin = false;
let basesCache = [];

// =====================================================================
// AUTENTICAÇÃO
// =====================================================================

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  hide($("loginError"));
  $("loginBtn").disabled = true;
  $("loginBtn").textContent = "Entrando…";

  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  $("loginBtn").disabled = false;
  $("loginBtn").textContent = "Entrar";

  if (error) {
    $("loginError").textContent = "Não foi possível entrar: " + error.message;
    show($("loginError"));
    return;
  }
  await onLoggedIn(data.user);
});

$("logoutBtn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  location.reload();
});

async function onLoggedIn(user) {
  currentUser = user;
  const { data: perfilRow } = await supabaseClient
    .from("usuarios_perfis").select("perfil, ativo").eq("id", user.id).maybeSingle();

  hide($("loginView"));
  show($("appView"));
  $("sessionEmail").textContent = user.email;
  $("sessionPerfil").textContent = perfilRow?.ativo ? perfilRow.perfil : "SEM PERFIL";

  isAdmin = !!(perfilRow?.ativo && perfilRow.perfil === "ADMIN");
  if (!isAdmin) {
    show($("semPermissaoBanner"));
    document.querySelectorAll("#mainContent form, #mainContent button").forEach((el) => (el.disabled = true));
  }

  await carregarTudo();
}

supabaseClient.auth.getSession().then(({ data }) => {
  if (data.session) onLoggedIn(data.session.user);
});

// =====================================================================
// CARREGAMENTO
// =====================================================================

async function carregarTudo() {
  await Promise.all([carregarBases(), carregarOsContrato(), carregarContratoBase(), carregarFretes()]);
}

async function carregarBases() {
  const { data, error } = await supabaseClient.from("bases").select("id, nome, cidade, estado, ativa").order("nome");
  if (error) { mostrarErro("baseError", error.message); return; }
  basesCache = data || [];

  renderList("basesList", basesCache, (b) => ({
    name: b.nome,
    meta: [b.cidade, b.estado].filter(Boolean).join(" / "),
    tag: b.ativa ? { text: "ativa", cls: "ativa" } : { text: "inativa", cls: "inativa" },
    actionLabel: b.ativa ? "Desativar" : "Reativar",
    onAction: () => alternarBaseAtiva(b.id, !b.ativa),
  }), "Nenhuma base cadastrada ainda.");

  // popular selects de base nas outras seções
  const options = '<option value="">Selecione…</option>' +
    basesCache.filter((b) => b.ativa).map((b) => `<option value="${b.id}">${b.nome}</option>`).join("");
  $("cbBaseId").innerHTML = options;
  $("freteBaseOrigem").innerHTML = '<option value="">—</option>' +
    basesCache.filter((b) => b.ativa).map((b) => `<option value="${b.id}">${b.nome}</option>`).join("");
}

async function carregarOsContrato() {
  const { data, error } = await supabaseClient
    .from("os_contrato").select("id, ordem_servico, sup_contrato, data_inicio")
    .eq("ativo", true).is("data_fim", null).order("ordem_servico");
  if (error) { mostrarErro("osContratoError", error.message); return; }

  renderList("osContratoList", data, (r) => ({
    name: `${r.ordem_servico} → ${r.sup_contrato}`,
    meta: `vigente desde ${formatarData(r.data_inicio)}`,
  }), "Nenhum vínculo OS → Contrato cadastrado ainda.");
}

async function carregarContratoBase() {
  const { data, error } = await supabaseClient
    .from("contrato_base").select("id, sup_contrato, base_id, data_inicio, bases(nome)")
    .eq("ativo", true).is("data_fim", null).order("sup_contrato");
  if (error) { mostrarErro("contratoBaseError", error.message); return; }

  renderList("contratoBaseList", data, (r) => ({
    name: `${r.sup_contrato} → ${r.bases?.nome || "(base removida)"}`,
    meta: `vigente desde ${formatarData(r.data_inicio)}`,
  }), "Nenhum vínculo Contrato → Base cadastrado ainda.");
}

async function carregarFretes() {
  const { data, error } = await supabaseClient
    .from("fretes").select("id, codigo_frete, status, transportadora, motorista, placa, data_prevista_chegada, base_origem_id")
    .order("codigo_frete");
  if (error) { mostrarErro("freteError", error.message); return; }

  renderList("fretesList", data, (f) => {
    const base = basesCache.find((b) => b.id === f.base_origem_id);
    const metaParts = [
      f.transportadora, f.motorista, f.placa,
      base ? "saindo de " + base.nome : null,
      f.data_prevista_chegada ? "previsão " + formatarData(f.data_prevista_chegada) : null,
    ].filter(Boolean);
    return {
      name: f.codigo_frete,
      meta: metaParts.join(" · "),
      statusSelect: { value: f.status, onChange: (novoStatus) => atualizarStatusFrete(f.id, novoStatus) },
    };
  }, "Nenhum frete cadastrado ainda.");
}

// =====================================================================
// AÇÕES: BASES
// =====================================================================

$("formBase").addEventListener("submit", async (e) => {
  e.preventDefault();
  hide($("baseError"));
  const nome = $("baseNome").value.trim();
  const cidade = $("baseCidade").value.trim() || null;
  const estado = $("baseEstado").value.trim() || null;
  if (!nome) return;

  const { error } = await supabaseClient.from("bases").insert({ nome, cidade, estado });
  if (error) { mostrarErro("baseError", error.message); return; }

  $("formBase").reset();
  await carregarBases();
});

async function alternarBaseAtiva(baseId, novoValor) {
  const { error } = await supabaseClient.from("bases").update({ ativa: novoValor }).eq("id", baseId);
  if (error) { mostrarErro("baseError", error.message); return; }
  await carregarBases();
}

// =====================================================================
// AÇÕES: OS -> CONTRATO (com lógica de vigência)
// =====================================================================

$("formOsContrato").addEventListener("submit", async (e) => {
  e.preventDefault();
  hide($("osContratoError")); hide($("osContratoSuccess"));

  const ordemServico = $("osOrdemServico").value.trim();
  const supContrato = $("osSupContrato").value.trim();
  if (!ordemServico || !supContrato) return;

  try {
    const resultado = await vincularComVigencia("os_contrato", "ordem_servico", ordemServico, "sup_contrato", supContrato);
    $("osContratoSuccess").textContent = mensagemResultado(resultado, "OS", ordemServico, supContrato);
    show($("osContratoSuccess"));
    $("formOsContrato").reset();
    await carregarOsContrato();
  } catch (err) {
    mostrarErro("osContratoError", err.message);
  }
});

// =====================================================================
// AÇÕES: CONTRATO -> BASE (com lógica de vigência)
// =====================================================================

$("formContratoBase").addEventListener("submit", async (e) => {
  e.preventDefault();
  hide($("contratoBaseError")); hide($("contratoBaseSuccess"));

  const supContrato = $("cbSupContrato").value.trim();
  const baseId = $("cbBaseId").value;
  if (!supContrato || !baseId) return;

  try {
    const resultado = await vincularComVigencia("contrato_base", "sup_contrato", supContrato, "base_id", baseId);
    const baseNome = basesCache.find((b) => b.id === baseId)?.nome || baseId;
    $("contratoBaseSuccess").textContent = mensagemResultado(resultado, "Contrato", supContrato, baseNome);
    show($("contratoBaseSuccess"));
    $("formContratoBase").reset();
    await carregarContratoBase();
  } catch (err) {
    mostrarErro("contratoBaseError", err.message);
  }
});

function mensagemResultado(resultado, tipoChave, chave, valor) {
  if (resultado === "skipped") return `${tipoChave} "${chave}" já estava vinculada a "${valor}". Nada mudou.`;
  if (resultado === "corrected") return `Vínculo de "${chave}" corrigido para "${valor}" (ajuste feito hoje mesmo).`;
  return `"${chave}" agora está vinculada a "${valor}". O vínculo anterior (se havia) foi encerrado e preservado no histórico.`;
}

// Lógica de vigência compartilhada entre os_contrato e contrato_base.
// Testada isoladamente contra o schema real antes da entrega desta tela.
async function vincularComVigencia(tabela, colunaChave, valorChave, colunaAlvo, valorAlvo) {
  const dataHoje = hoje();

  const { data: ativos, error: erroSelect } = await supabaseClient
    .from(tabela).select(`id, ${colunaAlvo}, data_inicio`)
    .eq(colunaChave, valorChave).eq("ativo", true).is("data_fim", null);
  if (erroSelect) throw erroSelect;

  const jaVinculadoAoMesmo = (ativos || []).some((a) => String(a[colunaAlvo]) === String(valorAlvo));
  if (jaVinculadoAoMesmo) return "skipped";

  for (const ativo of ativos || []) {
    if (ativo.data_inicio === dataHoje) {
      const { error } = await supabaseClient.from(tabela).update({ [colunaAlvo]: valorAlvo }).eq("id", ativo.id);
      if (error) throw error;
      return "corrected";
    } else {
      const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const { error } = await supabaseClient.from(tabela).update({ data_fim: ontem, ativo: false }).eq("id", ativo.id);
      if (error) throw error;
    }
  }

  const { error: erroInsert } = await supabaseClient.from(tabela).insert({ [colunaChave]: valorChave, [colunaAlvo]: valorAlvo });
  if (erroInsert) throw erroInsert;
  return "inserted";
}

// =====================================================================
// AÇÕES: FRETES
// =====================================================================

$("formFrete").addEventListener("submit", async (e) => {
  e.preventDefault();
  hide($("freteError"));

  const payload = {
    codigo_frete: $("freteCodigo").value.trim(),
    base_origem_id: $("freteBaseOrigem").value || null,
    transportadora: $("freteTransportadora").value.trim() || null,
    motorista: $("freteMotorista").value.trim() || null,
    placa: $("fretePlaca").value.trim() || null,
    data_prevista_chegada: $("fretePrevisaoChegada").value || null,
  };
  if (!payload.codigo_frete) return;

  const { error } = await supabaseClient.from("fretes").insert(payload);
  if (error) { mostrarErro("freteError", error.message); return; }

  $("formFrete").reset();
  await carregarFretes();
});

async function atualizarStatusFrete(freteId, novoStatus) {
  const { error } = await supabaseClient.from("fretes").update({ status: novoStatus }).eq("id", freteId);
  if (error) { mostrarErro("freteError", error.message); return; }
  await carregarFretes();
}

// =====================================================================
// HELPERS DE RENDERIZAÇÃO
// =====================================================================

function mostrarErro(elId, mensagem) {
  const el = $(elId);
  el.textContent = "Erro: " + mensagem;
  show(el);
}

function formatarData(iso) {
  if (!iso) return "";
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

function renderList(containerId, items, mapFn, emptyMessage) {
  const container = $(containerId);
  if (!items || items.length === 0) {
    container.innerHTML = "";
    container.style.background = "none";
    container.style.border = "none";
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = emptyMessage;
    container.appendChild(note);
    return;
  }
  container.style.background = "var(--line)";
  container.style.border = "1px solid var(--line)";
  container.innerHTML = "";

  items.forEach((item) => {
    const mapped = mapFn(item);
    const row = document.createElement("div");
    row.className = "card-row";

    const left = document.createElement("div");
    left.innerHTML = `<span class="name">${mapped.name}</span>` +
      (mapped.meta ? `<div class="meta">${mapped.meta}</div>` : "");
    row.appendChild(left);

    const right = document.createElement("div");
    right.className = "actions";

    if (mapped.tag) {
      const tagEl = document.createElement("span");
      tagEl.className = "tag " + mapped.tag.cls;
      tagEl.textContent = mapped.tag.text;
      right.appendChild(tagEl);
    }

    if (mapped.statusSelect) {
      const sel = document.createElement("select");
      sel.className = "status-select";
      sel.disabled = !isAdmin;
      STATUS_FRETE.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s; opt.textContent = s;
        if (s === mapped.statusSelect.value) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", () => mapped.statusSelect.onChange(sel.value));
      right.appendChild(sel);
    }

    if (mapped.actionLabel) {
      const btn = document.createElement("button");
      btn.className = "small";
      btn.textContent = mapped.actionLabel;
      btn.disabled = !isAdmin;
      btn.addEventListener("click", mapped.onAction);
      right.appendChild(btn);
    }

    row.appendChild(right);
    container.appendChild(row);
  });
}
