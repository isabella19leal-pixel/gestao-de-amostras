// =====================================================================
// GESTÃO DE AMOSTRAS SOND — Dashboard (Etapa 3, V1)
// =====================================================================
// V1 é SOMENTE LEITURA: mostra números executivos, bases, contratos
// sem base, OS sem contrato, fretes previstos e a tabela detalhada de
// amostras, com filtros e paginação no navegador.
//
// DECISÕES DE AGREGAÇÃO (documentadas aqui para revisão):
//
// 1) Agrupamento dos 9 status técnicos em 3 grandes números executivos:
//      aguardando_transporte = COLETADA, NA_BASE, AGUARDANDO_FRETE, FRETE_CONTRATADO
//      em_transito           = EM_TRANSITO
//      em_sao_pedro          = CHEGOU_SAO_PEDRO, RECEBIDA, EM_ENSAIO, ENSAIADA
//
// 2) "Base atual" de uma amostra é derivada assim, em ordem de prioridade:
//      a) se amostras.base_logistica_id estiver preenchido, usa ele direto;
//      b) senão, tenta achar a vigência ATIVA (ativo=true, data_fim IS NULL)
//         em os_contrato para a ordem_servico da amostra, pega o
//         sup_contrato, e então busca a vigência ATIVA correspondente em
//         contrato_base para achar a base.
//      c) se nada disso resolver, a amostra aparece como "sem base".
//    Esta derivação usa a vigência CORRENTE (não tenta casar pela data da
//    coleta) — é uma simplificação da V1. Se no futuro for necessário
//    reconstruir a base "histórica" exata na data da coleta, essa lógica
//    precisa ser ajustada para comparar com data_coleta.
//
// 3) Tudo é buscado uma vez e processado no navegador (sem paginação no
//    servidor). Isso é adequado até a casa de dezenas de milhares de
//    linhas; se o volume crescer muito além disso, valerá a pena mover
//    filtros/paginação para consultas no Supabase.
// =====================================================================

const PAGE_SIZE = 50;

const STATUS_LABELS = {
    COLETADA: "Coletada",
    NA_BASE: "Na base",
    AGUARDANDO_FRETE: "Aguardando frete",
    FRETE_CONTRATADO: "Frete contratado",
    EM_TRANSITO: "Em trânsito",
    CHEGOU_SAO_PEDRO: "Em São Pedro",
    RECEBIDA: "Recebida",
    EM_ENSAIO: "Em ensaio",
    ENSAIADA: "Ensaiada",
};

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

let currentUser = null;
let allAmostras = [];       // linhas já processadas (com base derivada e status label)
let filteredAmostras = [];  // após aplicar filtros
let currentPage = 1;

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
      .from("usuarios_perfis")
      .select("perfil, ativo")
      .eq("id", user.id)
      .maybeSingle();

  hide($("loginView"));
    show($("appView"));
    $("sessionEmail").textContent = user.email;
    $("sessionPerfil").textContent = perfilRow?.ativo ? perfilRow.perfil : "SEM PERFIL";

  await carregarTudo();
}

supabaseClient.auth.getSession().then(({ data }) => {
    if (data.session) onLoggedIn(data.session.user);
});

// =====================================================================
// CARREGAMENTO E PROCESSAMENTO DOS DADOS
// =====================================================================

async function carregarTudo() {
    try {
          const [amostrasRaw, basesRes, osContratoRes, contratoBaseRes, fretesRes] = await Promise.all([
                  buscarTodasAsLinhas("amostras",
                                              "id, codigo_amostra, cliente, ordem_servico, identificacao, coletado_por, " +
                                              "status_logistico, data_coleta, base_logistica_id, frete_atual_id"
                                            ),
                  supabaseClient.from("bases").select("id, nome, cidade, estado, ativa").eq("ativa", true),
                  supabaseClient.from("os_contrato").select("ordem_servico, sup_contrato").eq("ativo", true).is("data_fim", null),
                  supabaseClient.from("contrato_base").select("sup_contrato, base_id").eq("ativo", true).is("data_fim", null),
                  supabaseClient.from("fretes").select("id, codigo_frete, status, base_origem_id, data_prevista_saida, data_prevista_chegada").neq("status", "FINALIZADO"),
                ]);

      for (const r of [basesRes, osContratoRes, contratoBaseRes, fretesRes]) {
              if (r.error) throw r.error;
      }

      const bases = basesRes.data || [];
          const osContrato = osContratoRes.data || [];
          const contratoBase = contratoBaseRes.data || [];
          const fretes = fretesRes.data || [];

      processarEExibir(amostrasRaw, bases, osContrato, contratoBase, fretes);

      hide($("loadingNote"));
          show($("dashboardContent"));
    } catch (err) {
          hide($("loadingNote"));
          $("errorBanner").textContent = "Erro ao carregar dados: " + err.message;
          show($("errorBanner"));
    }
}

// O Supabase/PostgREST limita cada requisição a no máximo 1000 linhas por
// padrão. Como a tabela "amostras" já passa disso, buscamos em páginas de
// 1000 até a página voltar vazia (ou menor que o tamanho pedido), juntando
// tudo num único array antes de processar.
async function buscarTodasAsLinhas(tabela, colunas, tamanhoPagina = 1000) {
    let todas = [];
    let pagina = 0;
    while (true) {
          const inicio = pagina * tamanhoPagina;
          const fim = inicio + tamanhoPagina - 1;
          const { data, error } = await supabaseClient.from(tabela).select(colunas).range(inicio, fim);
          if (error) throw error;
          todas = todas.concat(data || []);
          if (!data || data.length < tamanhoPagina) break;
          pagina++;
    }
    return todas;
}

function processarEExibir(amostrasRaw, bases, osContrato, contratoBase, fretes) {
    const baseById = new Map(bases.map((b) => [b.id, b]));
    const osParaContrato = new Map(osContrato.map((r) => [r.ordem_servico, r.sup_contrato]));
    const contratoParaBase = new Map(contratoBase.map((r) => [r.sup_contrato, r.base_id]));
    const freteById = new Map(fretes.map((f) => [f.id, f]));

  // ---- deriva base_id e nome de base para cada amostra ----
  const amostras = amostrasRaw.map((a) => {
        let baseId = a.base_logistica_id || null;
        if (!baseId) {
                const supContrato = osParaContrato.get(a.ordem_servico);
                if (supContrato) baseId = contratoParaBase.get(supContrato) || null;
        }
        const base = baseId ? baseById.get(baseId) : null;
        const frete = a.frete_atual_id ? freteById.get(a.frete_atual_id) : null;

                                       return {
                                               ...a,
                                               base_derivada_id: baseId,
                                               base_nome: base ? base.nome : null,
                                               status_label: STATUS_LABELS[a.status_logistico] || a.status_logistico,
                                               frete_codigo: frete ? frete.codigo_frete : null,
                                               frete_previsao: frete ? frete.data_prevista_chegada : null,
                                       };
  });

  allAmostras = amostras;

  // ---- resumo executivo ----
  const total = amostras.length;
    const aguardando = amostras.filter((a) =>
          ["COLETADA", "NA_BASE", "AGUARDANDO_FRETE", "FRETE_CONTRATADO"].includes(a.status_logistico)
                                         ).length;
    const transito = amostras.filter((a) => a.status_logistico === "EM_TRANSITO").length;
    const saoPedro = amostras.filter((a) =>
          ["CHEGOU_SAO_PEDRO", "RECEBIDA", "EM_ENSAIO", "ENSAIADA"].includes(a.status_logistico)
                                       ).length;

  $("hTotal").textContent = total;
    $("hAguardando").textContent = aguardando;
    $("hTransito").textContent = transito;
    $("hSaoPedro").textContent = saoPedro;

  // ---- contratos sem base (os_contrato ativo cujo sup_contrato não tem contrato_base ativo) ----
  const contratosSemBase = [...new Set(osContrato.map((r) => r.sup_contrato))].filter(
        (sup) => !contratoParaBase.has(sup)
      );

  // ---- OS sem contrato vinculado (OS distintas nas amostras que não têm os_contrato ativo) ----
  const osDistintasNasAmostras = [...new Set(amostrasRaw.map((a) => a.ordem_servico))];
    const osSemContrato = osDistintasNasAmostras.filter((os) => !osParaContrato.has(os));

  $("sBases").textContent = bases.length;
    $("sContratosSemBase").textContent = contratosSemBase.length;
    $("sOsSemContrato").textContent = osSemContrato.length;
    $("sFretes").textContent = fretes.length;

  // ---- bloco Bases: quantidade de amostras por base ----
  const contagemPorBase = new Map();
    let semBaseCount = 0;
    amostras.forEach((a) => {
          if (a.base_derivada_id) {
                  contagemPorBase.set(a.base_derivada_id, (contagemPorBase.get(a.base_derivada_id) || 0) + 1);
          } else {
                  semBaseCount++;
          }
    });

  renderCardList(
        "basesList",
        bases.length === 0
          ? null
          : bases.map((b) => ({
                      name: b.nome,
                      meta: [b.cidade, b.estado].filter(Boolean).join(" / "),
                      count: contagemPorBase.get(b.id) || 0,
          })),
        "Nenhuma base cadastrada ainda. Cadastre bases na tabela \"bases\" do Supabase."
      );
    if (semBaseCount > 0 && bases.length > 0) {
          const list = $("basesList");
          const row = document.createElement("div");
          row.className = "card-row";
          row.innerHTML = `<span class="name" style="color:var(--stone-dim);">Sem base atribuída</span><span class="count warn mono">${semBaseCount}</span>`;
          list.appendChild(row);
    }

  // ---- bloco Contratos sem base ----
  renderCardList(
        "contratosSemBaseList",
        osContrato.length === 0
          ? null
          : contratosSemBase.map((sup) => ({ name: sup, meta: "", count: null })),
        osContrato.length === 0
          ? "Nenhum vínculo OS → Contrato cadastrado ainda."
          : "Todos os contratos cadastrados já têm base vinculada."
      );

  // ---- bloco OS sem contrato ----
  renderCardList(
        "osSemContratoList",
        osSemContrato.length === 0
          ? null
          : osSemContrato.slice(0, 50).map((os) => ({ name: os, meta: "", count: null })),
        "Todas as OS das amostras importadas já têm contrato vinculado."
      );

  // ---- bloco Fretes previstos ----
  renderCardList(
        "fretesList",
        fretes.length === 0
          ? null
          : fretes.map((f) => {
                      const base = f.base_origem_id ? baseById.get(f.base_origem_id) : null;
                      return {
                                    name: f.codigo_frete,
                                    meta: `${f.status}${base ? " · saindo de " + base.nome : ""}${f.data_prevista_chegada ? " · previsão " + formatarData(f.data_prevista_chegada) : ""}`,
                                    count: null,
                      };
          }),
        "Nenhum frete programado no momento."
      );

  // ---- filtros: popular selects ----
  const fBase = $("fBase");
    fBase.innerHTML = '<option value="">Todas as bases</option>';
    bases.forEach((b) => {
          const opt = document.createElement("option");
          opt.value = b.id;
          opt.textContent = b.nome;
          fBase.appendChild(opt);
    });
    const semBaseOpt = document.createElement("option");
    semBaseOpt.value = "__sem_base__";
    semBaseOpt.textContent = "Sem base atribuída";
    fBase.appendChild(semBaseOpt);

  const fStatus = $("fStatus");
    fStatus.innerHTML = '<option value="">Todos os status</option>';
    Object.entries(STATUS_LABELS).forEach(([value, label]) => {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = label;
          fStatus.appendChild(opt);
    });

  aplicarFiltros();
}

function renderCardList(containerId, items, emptyMessage) {
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
    container.innerHTML = items.map((item) => `
        <div class="card-row">
              <div>
                      <span class="name">${item.name}</span>
                              ${item.meta ? `<div class="meta">${item.meta}</div>` : ""}
                                    </div>
                                          ${item.count !== null ? `<span class="count mono">${item.count}</span>` : ""}
                                              </div>
                                                `).join("");
}

function formatarData(iso) {
    if (!iso) return "";
    const [ano, mes, dia] = iso.split("-");
    return `${dia}/${mes}/${ano}`;
}

// =====================================================================
// FILTROS, BUSCA E PAGINAÇÃO DA TABELA
// =====================================================================

$("fBusca").addEventListener("input", () => { currentPage = 1; aplicarFiltros(); });
$("fBase").addEventListener("change", () => { currentPage = 1; aplicarFiltros(); });
$("fStatus").addEventListener("change", () => { currentPage = 1; aplicarFiltros(); });
$("prevPageBtn").addEventListener("click", () => { if (currentPage > 1) { currentPage--; renderTabela(); } });
$("nextPageBtn").addEventListener("click", () => {
    const maxPage = Math.ceil(filteredAmostras.length / PAGE_SIZE) || 1;
    if (currentPage < maxPage) { currentPage++; renderTabela(); }
});

function aplicarFiltros() {
    const busca = $("fBusca").value.trim().toLowerCase();
    const baseFiltro = $("fBase").value;
    const statusFiltro = $("fStatus").value;

  filteredAmostras = allAmostras.filter((a) => {
        if (busca) {
                const alvo = `${a.codigo_amostra} ${a.ordem_servico} ${a.cliente || ""}`.toLowerCase();
                if (!alvo.includes(busca)) return false;
        }
        if (baseFiltro === "__sem_base__" && a.base_derivada_id) return false;
        if (baseFiltro && baseFiltro !== "__sem_base__" && a.base_derivada_id !== baseFiltro) return false;
        if (statusFiltro && a.status_logistico !== statusFiltro) return false;
        return true;
  });

  $("tableCount").textContent = `${filteredAmostras.length} de ${allAmostras.length}`;
    renderTabela();
}

function renderTabela() {
    const maxPage = Math.ceil(filteredAmostras.length / PAGE_SIZE) || 1;
    if (currentPage > maxPage) currentPage = maxPage;

  const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = filteredAmostras.slice(start, start + PAGE_SIZE);

  $("tableBody").innerHTML = pageItems.map((a) => `
      <tr>
            <td class="code">${a.codigo_amostra}</td>
                  <td>${a.cliente || "—"}</td>
                        <td>${a.ordem_servico} / ${a.identificacao}</td>
                              <td>${a.coletado_por || "—"}</td>
                                    <td>${a.base_nome || "—"}</td>
                                          <td><span class="status-tag st-${a.status_logistico.toLowerCase()}">${a.status_label}</span></td>
                                                <td>${formatarData(a.data_coleta) || "—"}</td>
                                                      <td>${a.frete_codigo ? a.frete_codigo + (a.frete_previsao ? " · " + formatarData(a.frete_previsao) : "") : "—"}</td>
                                                          </tr>
                                                            `).join("");

  $("pageInfo").textContent = `página ${currentPage} de ${maxPage}`;
    $("prevPageBtn").disabled = currentPage <= 1;
    $("nextPageBtn").disabled = currentPage >= maxPage;
}
