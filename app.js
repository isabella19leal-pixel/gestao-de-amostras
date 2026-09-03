// =====================================================================
// GESTÃO DE AMOSTRAS SOND — Importador (Etapa 2)
// =====================================================================
// Fluxo: Excel da Sond → SheetJS (leitura) → validação → upsert por
// codigo_amostra → Supabase.
//
// Este arquivo NUNCA envia ao Supabase nenhum campo de gestão interna
// (base_logistica_id, status_logistico, frete_atual_id, datas
// logísticas, observacao). Só os campos que vêm originalmente da Sond
// são enviados — por isso o upsert nunca apaga informação de gestão
// já preenchida no dashboard (ver comentário no payload mais abaixo).
// =====================================================================

const IMPORT_BATCH_SIZE = 200;

// Mapa: cabeçalho real da planilha (já normalizado) -> coluna do banco.
// A normalização colapsa espaços múltiplos e tira espaços das pontas,
// então "Qtdade de Amostras  nesta Sondagem" (com espaço duplo) casa
// normalmente.
const HEADER_MAP = {
  "ordem de serviço (os)": "ordem_servico",
  "identificação": "identificacao",
  "qtdade de amostras nesta sondagem": "qtd_amostras_sondagem",
  "tomador": "cliente",
  "código amostra": "codigo_amostra",
  "rfid": "rfid",
  "tipo": "tipo",
  "status": "status_sond",
  "topo (m)": "topo_m",
  "base (m)": "base_m",
  "coletado por": "coletado_por",
  "data da coleta": "data_coleta",
  "data da criação": "data_criacao_sond",
};

const CAMPOS_OBRIGATORIOS = ["codigo_amostra", "ordem_servico", "identificacao"];

// ---------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentPerfil = null;
let parsedRows = [];     // linhas válidas prontas para importar
let problemRows = [];    // linhas com erro ou duplicadas (para exibir)
let currentFileName = "";

// ---------------------------------------------------------------------
// Helpers de DOM
// ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

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

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

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
  await supabase.auth.signOut();
  location.reload();
});

async function onLoggedIn(user) {
  currentUser = user;

  // Busca o perfil vinculado a este usuário (criado na Etapa 1).
  const { data: perfilRow, error } = await supabase
    .from("usuarios_perfis")
    .select("perfil, nome, ativo")
    .eq("id", user.id)
    .maybeSingle();

  hide($("loginView"));
  show($("appView"));

  $("sessionEmail").textContent = user.email;

  if (error || !perfilRow || !perfilRow.ativo) {
    currentPerfil = null;
    $("sessionPerfil").textContent = "SEM PERFIL";
    show($("semPerfilBanner"));
    hide($("stepUpload"));
    hide($("stepValidate"));
    hide($("stepConfirm"));
    hide($("stepResult"));
  } else {
    currentPerfil = perfilRow.perfil;
    $("sessionPerfil").textContent = currentPerfil;

    if (currentPerfil !== "ADMIN") {
      // COORDENACAO / GERENCIA: só consulta, sem importar.
      hide($("stepUpload"));
      hide($("stepValidate"));
      hide($("stepConfirm"));
      hide($("stepResult"));
      show($("semPerfilBanner"));
      $("semPerfilBanner").textContent =
        "Seu perfil (" + currentPerfil + ") tem acesso somente de consulta. " +
        "A importação de planilhas é exclusiva do perfil ADMIN.";
    }
  }

  carregarImportacoesRecentes();
}

// Se já existir uma sessão ativa (ex.: página recarregada), reaproveita.
supabase.auth.getSession().then(({ data }) => {
  if (data.session) {
    onLoggedIn(data.session.user);
  }
});

// =====================================================================
// SELEÇÃO DO ARQUIVO (dropzone + input)
// =====================================================================

const dropzone = $("dropzone");
const fileInput = $("fileInput");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener("change", (e) => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});

$("fileChipClear").addEventListener("click", resetImportador);

function resetImportador() {
  parsedRows = [];
  problemRows = [];
  currentFileName = "";
  fileInput.value = "";
  hide($("fileChip"));
  hide($("parseError"));
  $("stepValidate").classList.add("is-disabled");
  $("stepConfirm").classList.add("is-disabled");
  $("stepResult").classList.add("is-disabled");
  hide($("resultBox"));
  hide($("progressBox"));
}

async function handleFile(file) {
  resetImportador();
  currentFileName = file.name;

  $("fileChipName").textContent = file.name;
  show($("fileChip"));

  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // header:1 -> array de arrays; preserva números como números e
    // datas-texto como texto (confirmado: a Sond exporta datas como
    // texto "dd/mm/aaaa", não como células de data reais).
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

    if (!rows.length) {
      throw new Error("A planilha está vazia.");
    }

    processarLinhas(rows);
  } catch (err) {
    $("parseError").textContent = "Erro ao ler o arquivo: " + err.message;
    show($("parseError"));
  }
}

// =====================================================================
// VALIDAÇÃO / NORMALIZAÇÃO
// =====================================================================

function normalizarCabecalho(texto) {
  return String(texto || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function parseDataBR(valor) {
  // Espera "dd/mm/aaaa" (texto). Retorna "aaaa-mm-dd" ou { erro, original }.
  if (valor === null || valor === undefined || valor === "") return null;
  const texto = String(valor).trim();
  const m = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return { erro: true, original: texto };

  const dia = parseInt(m[1], 10);
  const mes = parseInt(m[2], 10);
  const ano = parseInt(m[3], 10);

  if (mes < 1 || mes > 12) return { erro: true, original: texto };

  // Valida o dia de acordo com o mês/ano real (rejeita 31/04, 30/02, etc.)
  // usando UTC para não sofrer efeito de fuso horário do navegador.
  const dataObj = new Date(Date.UTC(ano, mes - 1, dia));
  const diaValido =
    dataObj.getUTCFullYear() === ano &&
    dataObj.getUTCMonth() === mes - 1 &&
    dataObj.getUTCDate() === dia;

  if (!diaValido) return { erro: true, original: texto };

  return `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

function paraTextoOuNull(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return texto === "" ? null : texto;
}

function paraNumeroOuNull(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Number(valor);
  return Number.isNaN(n) ? null : n;
}

function paraInteiroOuNull(valor) {
  const n = paraNumeroOuNull(valor);
  return n === null ? null : Math.trunc(n);
}

function processarLinhas(rows) {
  const headerRaw = rows[0];
  const headerNorm = headerRaw.map(normalizarCabecalho);

  // Localiza o índice de cada coluna esperada pelo nome normalizado.
  const colIndex = {};
  headerNorm.forEach((h, idx) => {
    if (HEADER_MAP[h] && !(HEADER_MAP[h] in colIndex)) {
      colIndex[HEADER_MAP[h]] = idx;
    }
  });

  const faltando = CAMPOS_OBRIGATORIOS.filter((campo) => !(campo in colIndex));
  if (faltando.length) {
    const nomesEsperados = {
      codigo_amostra: "Código Amostra",
      ordem_servico: "Ordem de Serviço (OS)",
      identificacao: "Identificação",
    };
    const lista = faltando.map((c) => nomesEsperados[c]).join(", ");
    $("parseError").textContent =
      `Não encontrei a(s) coluna(s) "${lista}" na planilha. ` +
      `Verifique se este é mesmo um arquivo exportado da Sond.`;
    show($("parseError"));
    return;
  }

  const validas = [];
  const problemas = [];
  const codigosVistos = new Set();

  for (let i = 1; i < rows.length; i++) {
    const linhaExcel = i + 1; // número da linha como aparece no Excel
    const row = rows[i];

    // Pula linhas totalmente vazias.
    if (!row || row.every((v) => v === null || v === undefined || v === "")) {
      continue;
    }

    const get = (campo) => (colIndex[campo] !== undefined ? row[colIndex[campo]] : null);

    const codigo_amostra = paraTextoOuNull(get("codigo_amostra"));
    const ordem_servico = paraTextoOuNull(get("ordem_servico"));
    const identificacao = paraTextoOuNull(get("identificacao"));

    if (!codigo_amostra) {
      problemas.push({ linha: linhaExcel, codigo: "—", motivo: "Código Amostra ausente", tipo: "erro" });
      continue;
    }
    if (!ordem_servico || !identificacao) {
      problemas.push({ linha: linhaExcel, codigo: codigo_amostra, motivo: "Ordem de Serviço ou Identificação ausente", tipo: "erro" });
      continue;
    }
    if (codigosVistos.has(codigo_amostra)) {
      problemas.push({ linha: linhaExcel, codigo: codigo_amostra, motivo: "Código Amostra duplicado dentro do próprio arquivo", tipo: "duplicado" });
      continue;
    }
    codigosVistos.add(codigo_amostra);

    const dataColeta = parseDataBR(get("data_coleta"));
    const dataCriacao = parseDataBR(get("data_criacao_sond"));

    if (dataColeta && dataColeta.erro) {
      problemas.push({ linha: linhaExcel, codigo: codigo_amostra, motivo: `Data da Coleta em formato inválido ("${dataColeta.original}")`, tipo: "erro" });
      continue;
    }
    if (dataCriacao && dataCriacao.erro) {
      problemas.push({ linha: linhaExcel, codigo: codigo_amostra, motivo: `Data da Criação em formato inválido ("${dataCriacao.original}")`, tipo: "erro" });
      continue;
    }

    validas.push({
      codigo_amostra,
      ordem_servico,
      identificacao,
      rfid: paraTextoOuNull(get("rfid")),
      qtd_amostras_sondagem: paraInteiroOuNull(get("qtd_amostras_sondagem")),
      cliente: paraTextoOuNull(get("cliente")),
      tipo: paraTextoOuNull(get("tipo")),
      status_sond: paraTextoOuNull(get("status_sond")),
      topo_m: paraNumeroOuNull(get("topo_m")),
      base_m: paraNumeroOuNull(get("base_m")),
      coletado_por: paraTextoOuNull(get("coletado_por")),
      data_coleta: dataColeta,
      data_criacao_sond: dataCriacao,
    });
  }

  parsedRows = validas;
  problemRows = problemas;

  exibirResumoValidacao(rows.length - 1);
}

function exibirResumoValidacao(totalLinhas) {
  const duplicadas = problemRows.filter((p) => p.tipo === "duplicado").length;
  const erros = problemRows.filter((p) => p.tipo === "erro").length;

  $("mTotal").textContent = totalLinhas;
  $("mValidas").textContent = parsedRows.length;
  $("mDuplicadas").textContent = duplicadas;
  $("mErros").textContent = erros;

  const tbody = $("detailTableBody");
  tbody.innerHTML = "";
  if (problemRows.length) {
    problemRows.forEach((p) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="mono">${p.linha}</td>
        <td class="code">${p.codigo}</td>
        <td class="reason ${p.tipo === "erro" ? "err" : "dup"}">${p.motivo}</td>
      `;
      tbody.appendChild(tr);
    });
    show($("detailBox"));
  } else {
    hide($("detailBox"));
  }

  $("stepValidate").classList.remove("is-disabled");

  if (parsedRows.length > 0) {
    $("stepConfirm").classList.remove("is-disabled");
  } else {
    $("stepConfirm").classList.add("is-disabled");
  }
}

$("cancelBtn").addEventListener("click", resetImportador);

// =====================================================================
// CONFIRMAÇÃO / UPSERT NO SUPABASE
// =====================================================================

$("confirmBtn").addEventListener("click", async () => {
  if (!parsedRows.length) return;

  $("confirmBtn").disabled = true;
  $("stepResult").classList.remove("is-disabled");
  show($("progressBox"));
  hide($("resultBox"));

  try {
    await executarImportacao();
  } catch (err) {
    alert("Falha inesperada durante a importação: " + err.message);
  } finally {
    $("confirmBtn").disabled = false;
  }
});

async function executarImportacao() {
  const duplicadosNoArquivo = problemRows.filter((p) => p.tipo === "duplicado").length;
  const errosDeLeitura = problemRows.filter((p) => p.tipo === "erro").length;

  // 1) Cria o registro da importação (fica com status "em andamento").
  const { data: importacao, error: erroImportacao } = await supabase
    .from("importacoes")
    .insert({
      nome_arquivo: currentFileName,
      usuario: currentUser.id,
      total_registros: parsedRows.length + problemRows.length,
      duplicados: duplicadosNoArquivo,
      erros: errosDeLeitura,
      observacao: "Importação em andamento…",
    })
    .select()
    .single();

  if (erroImportacao) {
    throw new Error("Não foi possível registrar a importação: " + erroImportacao.message);
  }

  const importacaoId = importacao.id;

  let novos = 0;
  let atualizados = 0;
  let errosUpsert = 0;
  const agora = new Date().toISOString();

  const lotes = [];
  for (let i = 0; i < parsedRows.length; i += IMPORT_BATCH_SIZE) {
    lotes.push(parsedRows.slice(i, i + IMPORT_BATCH_SIZE));
  }

  for (let i = 0; i < lotes.length; i++) {
    const lote = lotes[i];
    const codigos = lote.map((r) => r.codigo_amostra);

    $("progressTxt").textContent = `Processando lote ${i + 1} de ${lotes.length}…`;
    $("progressFill").style.width = `${Math.round(((i) / lotes.length) * 100)}%`;

    try {
      // Descobre quais códigos já existem ANTES do upsert, para poder
      // contar corretamente novos x atualizados.
      const { data: existentes, error: erroSelect } = await supabase
        .from("amostras")
        .select("codigo_amostra")
        .in("codigo_amostra", codigos);

      if (erroSelect) throw erroSelect;

      const existentesSet = new Set((existentes || []).map((r) => r.codigo_amostra));

      // Monta o payload SOMENTE com campos de origem Sond + controle de
      // importação. Nenhum campo de gestão (base_logistica_id,
      // status_logistico, frete_atual_id, datas logísticas, observacao)
      // é incluído aqui — por isso o upsert nunca os sobrescreve.
      const payload = lote.map((r) => ({
        codigo_amostra: r.codigo_amostra,
        rfid: r.rfid,
        ordem_servico: r.ordem_servico,
        identificacao: r.identificacao,
        qtd_amostras_sondagem: r.qtd_amostras_sondagem,
        cliente: r.cliente,
        tipo: r.tipo,
        status_sond: r.status_sond,
        topo_m: r.topo_m,
        base_m: r.base_m,
        coletado_por: r.coletado_por,
        data_coleta: r.data_coleta,
        data_criacao_sond: r.data_criacao_sond,
        data_importacao: agora,
        ultima_importacao_id: importacaoId,
      }));

      const { error: erroUpsert } = await supabase
        .from("amostras")
        .upsert(payload, { onConflict: "codigo_amostra" });

      if (erroUpsert) throw erroUpsert;

      codigos.forEach((c) => {
        if (existentesSet.has(c)) atualizados++; else novos++;
      });
    } catch (err) {
      errosUpsert += lote.length;
      console.error("Erro no lote", i + 1, err);
    }
  }

  $("progressFill").style.width = "100%";
  $("progressTxt").textContent = `Concluído: ${lotes.length} lote(s) processado(s).`;

  const totalErros = errosDeLeitura + errosUpsert;

  // 2) Atualiza o registro da importação com os números finais.
  await supabase
    .from("importacoes")
    .update({
      registros_novos: novos,
      registros_atualizados: atualizados,
      duplicados: duplicadosNoArquivo,
      erros: totalErros,
      observacao: errosUpsert > 0
        ? `${errosUpsert} registro(s) falharam ao gravar no banco (ver console do navegador).`
        : "Importação concluída sem falhas de gravação.",
    })
    .eq("id", importacaoId);

  $("rNovos").textContent = novos;
  $("rAtualizados").textContent = atualizados;
  $("rDuplicados").textContent = duplicadosNoArquivo;
  $("rErros").textContent = totalErros;
  show($("resultBox"));

  carregarImportacoesRecentes();
}

$("novaImportacaoBtn").addEventListener("click", resetImportador);

// =====================================================================
// IMPORTAÇÕES RECENTES
// =====================================================================

async function carregarImportacoesRecentes() {
  const container = $("historicoList");
  const { data, error } = await supabase
    .from("importacoes")
    .select("nome_arquivo, data_importacao, total_registros, registros_novos, registros_atualizados, duplicados, erros")
    .order("data_importacao", { ascending: false })
    .limit(10);

  if (error) {
    container.innerHTML = `<p class="empty-note">Não foi possível carregar o histórico (${error.message}).</p>`;
    return;
  }

  if (!data || !data.length) {
    container.innerHTML = `<p class="empty-note">Nenhuma importação registrada ainda.</p>`;
    return;
  }

  container.innerHTML = data.map((imp) => {
    const dt = new Date(imp.data_importacao);
    const dataFmt = dt.toLocaleDateString("pt-BR") + " " + dt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    return `
      <div class="import-row">
        <div>
          <div class="fname">${imp.nome_arquivo}</div>
          <div class="meta">${dataFmt}</div>
        </div>
        <div class="counts">
          novos ${imp.registros_novos ?? 0} · atualizados ${imp.registros_atualizados ?? 0} · dup ${imp.duplicados ?? 0} · erros ${imp.erros ?? 0}
        </div>
      </div>
    `;
  }).join("");
}
