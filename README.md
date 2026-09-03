# Gestão de Amostras Sond — Etapa 2: Importador Excel

Três arquivos, para colocar juntos na mesma pasta (ou repositório do GitHub Pages):

- `importador.html` — a página
- `app.js` — toda a lógica (login, leitura do Excel, validação, upsert)
- `config.js` — **você precisa editar este** com os dados do seu projeto Supabase

## 1. Configurar

Abra `config.js` e troque:

```js
const SUPABASE_URL = "COLE_AQUI_A_URL_DO_SEU_PROJETO";
const SUPABASE_ANON_KEY = "COLE_AQUI_A_CHAVE_ANON_PUBLIC";
```

Onde encontrar: Supabase → seu projeto → **Project Settings** (ícone de engrenagem) → **API**.

- `SUPABASE_URL` → campo "Project URL"
- `SUPABASE_ANON_KEY` → campo **anon / public** em "Project API keys"

⚠️ Use somente a chave **anon**. Nunca a `service_role`.

## 2. Testar localmente (opcional, antes de subir pro GitHub Pages)

Como o navegador bloqueia `fetch` de arquivos abertos direto com `file://`,
rode um servidor local simples na pasta:

```bash
# Python
python3 -m http.server 8080

# ou Node
npx serve .
```

Depois abra `http://localhost:8080/importador.html`.

## 3. Publicar no GitHub Pages

1. Suba os 3 arquivos (`importador.html`, `app.js`, `config.js`) para um
   repositório no GitHub.
2. No repositório: **Settings → Pages → Build and deployment → Deploy from
   a branch** → escolha a branch (`main`) e a pasta (`/root` ou `/docs`,
   dependendo de onde você colocou os arquivos).
3. Acesse a URL que o GitHub Pages gerar
   (algo como `https://seu-usuario.github.io/seu-repo/importador.html`).

Não é preciso configurar nada extra no Supabase para aceitar chamadas do
GitHub Pages — a API do Supabase (PostgREST) não bloqueia por domínio;
a segurança real está nas políticas de RLS que já criamos na Etapa 1.

## 4. Como usar

1. Abra a página → faça login com um e-mail/senha que já tenha perfil
   **ADMIN** vinculado (criado na Etapa 1).
2. Arraste o `.xlsx` exportado da Sond na área de importação.
3. Confira o resumo de validação (total, prontas, duplicadas, com erro).
4. Clique em **Confirmar importação**.
5. Veja o resultado (novos / atualizados / duplicados / erros) e o
   histórico de importações recentes na parte de baixo da página.

Usuários com perfil **COORDENACAO** ou **GERENCIA** conseguem fazer login,
mas a área de importação fica bloqueada — eles só têm acesso de consulta
(a lista de importações recentes ainda aparece para eles).

## O que o importador garante

- **Upsert por `Código Amostra`**: nunca duplica uma amostra já existente.
- **Nunca apaga dados de gestão**: o payload enviado ao Supabase inclui
  *somente* os campos que vêm originalmente da Sond (OS, identificação,
  status, RFID, tipo, topo/base, coletado por, datas de coleta/criação).
  Campos preenchidos no dashboard — base, frete, status logístico, datas
  logísticas, observações — nunca são tocados pela reimportação, porque
  simplesmente não fazem parte do payload enviado.
- **Valida antes de importar**: código de amostra ausente, OS/Identificação
  ausente, datas em formato inválido (inclusive datas "impossíveis" como
  31/13 ou 30/02) e duplicidade dentro do próprio arquivo são detectados
  e mostrados antes de qualquer gravação no banco.
- **Rastreabilidade**: cada amostra grava qual foi a última importação que
  a atualizou (`ultima_importacao_id`) e a tabela `importacoes` guarda o
  resumo de cada arquivo processado (novos, atualizados, duplicados, erros).

## O que foi testado antes da entrega

- Os 2 arquivos reais da Sond (`Amostras_coletadas_dia_02-09.xlsx` e
  `amostras-coletadas (8).xlsx`) foram processados pela lógica real do
  `app.js` (rodada em Node.js) — 100% das linhas válidas nos dois, sem
  falsos positivos de erro.
- Casos de erro propositais (código ausente, OS/Identificação ausente,
  data com mês/dia inválido, duplicidade dentro do arquivo) foram
  detectados corretamente.
- Simulação completa ponta a ponta contra um Postgres com o schema real
  da Etapa 1: importação do arquivo grande (1116 novas) → ADMIN preenche
  campos de gestão manualmente → reimportação do arquivo pequeno
  (75 linhas, 100% já existentes) → resultado: 0 novos, 75 atualizados,
  total permanece 1116 (sem duplicar), e os campos de gestão preenchidos
  manualmente continuam intactos depois da reimportação.
