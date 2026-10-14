// ============================================================
// Planta Cadastral — Parelhas/RN
// Mapa com busca de endereço tolerante a erros de digitação.
// ============================================================

(function () {
  "use strict";

  // ---------- Configuração ----------

  // Centro aproximado de Parelhas/RN (SIRGAS 2000 / WGS84), usado só
  // como fallback antes dos dados carregarem.
  const CENTRO_FALLBACK = [-6.6775, -36.6625];
  const ZOOM_INICIAL = 15;
  const ZOOM_MAX = 21;

  const URL_DADOS = "data/lotes.geojson";

  // Cores dos status (precisam bater com style.css)
  const CORES = {
    completo: "#3d7a5c",
    incompleto: "#c9a227",
    inconsistente: "#b4493d",
    selecionado: "#2f6fed",
  };

  // ---------- Estado ----------

  let mapa;
  let camadaLotes; // L.geoJSON layer
  let fuse; // índice de busca
  let registrosBusca = [];
  let idsBusca = new Set();
  let buscaColetiva = false;
  let featuresPorId = new Map(); // id interno -> {feature, layer}
  let layerSelecionado = null;
  let camadaNumeros;
  const rotulosNumeros = [];

  function numeroDoRotulo(props) {
    if (/\d/.test(String(props.numero || ""))) return String(props.numero).trim();
    if (/\d/.test(String(props.numero2 || ""))) return String(props.numero2).trim();
    return "";
  }

  function atualizarNumeros() {
    if (!camadaNumeros) return;
    camadaNumeros.clearLayers();
    if (mapa.getZoom() < 18 || !document.getElementById("mostrarNumeros").checked) return;
    const limites = mapa.getBounds();
    rotulosNumeros.forEach(({ id, posicao, texto }) => {
      if (!limites.contains(posicao)) return;
      if (gruposAtivos.size && !idsAgrupamento.has(id)) return;
      const span = document.createElement("span");
      span.textContent = texto;
      L.marker(posicao, {
        icon: L.divIcon({ className: "numero-lote", html: span, iconSize: [0, 0] }),
        interactive: false, keyboard: false,
      }).addTo(camadaNumeros);
    });
  }
  const gruposAtivos = new Set();
  let idsAgrupamento = new Set();
  const GRUPOS = ["sem-numero", "com-numero", "ausente", "vazio"];

  // As anotações explícitas têm prioridade sobre a numeração.
  function grupoDoLote(props) {
    const anotacoes = normalizarTexto([props.numero, props.inconsiste].filter(Boolean).join(" "));
    if (/\blote vazio\b/.test(anotacoes)) return "vazio";
    if (/\bausente\b/.test(anotacoes)) return "ausente";
    if (/\d/.test(String(props.numero || "")) || /\d/.test(String(props.numero2 || ""))) return "com-numero";
    return "sem-numero";
  }

  function atualizarAgrupamentos() {
    const contagens = Object.fromEntries(GRUPOS.map((g) => [g, 0]));
    idsAgrupamento = new Set();
    featuresPorId.forEach(({ feature }, id) => {
      if (buscaColetiva && !idsBusca.has(id)) return;
      const grupo = grupoDoLote(feature.properties);
      contagens[grupo]++;
      if (gruposAtivos.has(grupo)) idsAgrupamento.add(id);
    });
    GRUPOS.forEach((g) => {
      document.getElementById("contagem-" + g).textContent = contagens[g].toLocaleString("pt-BR");
      document.getElementById("grupo-" + g).disabled = !camadaLotes;
    });
    document.getElementById("escopoGrupos").textContent = buscaColetiva
      ? "Dentro do bairro ou da rua pesquisados" : "Em todo o cadastro";
    document.getElementById("totalGrupos").textContent = gruposAtivos.size
      ? idsAgrupamento.size.toLocaleString("pt-BR") + " lotes marcados" : "Selecione um ou mais grupos";
    document.getElementById("enquadrarGrupos").disabled = !idsAgrupamento.size;
    document.getElementById("limparGrupos").disabled = !gruposAtivos.size;
    if (camadaLotes) {
      camadaLotes.resetStyle();
      idsAgrupamento.forEach((id) => featuresPorId.get(id).layer.bringToFront());
      if (layerSelecionado) {
        layerSelecionado.setStyle(estiloSelecionado());
        layerSelecionado.bringToFront();
      }
    }
    atualizarNumeros();
  }

  function enquadrarGrupos() {
    if (!idsAgrupamento.size) return;
    const bounds = L.latLngBounds([]);
    idsAgrupamento.forEach((id) => bounds.extend(featuresPorId.get(id).layer.getBounds()));
    mapa.fitBounds(bounds, { padding: [60, 80], maxZoom: 18 });
  }

  function inicializarAgrupamentos() {
    GRUPOS.forEach((grupo) => {
      document.getElementById("grupo-" + grupo).addEventListener("change", function (ev) {
        if (ev.target.checked) gruposAtivos.add(grupo);
        else gruposAtivos.delete(grupo);
        fecharPainelDetalhes();
        atualizarAgrupamentos();
      });
    });
    document.getElementById("limparGrupos").addEventListener("click", function () {
      gruposAtivos.clear();
      GRUPOS.forEach((g) => { document.getElementById("grupo-" + g).checked = false; });
      atualizarAgrupamentos();
    });
    document.getElementById("enquadrarGrupos").addEventListener("click", enquadrarGrupos);
  }

  // ---------- Inicialização do mapa ----------

  function criarMapa() {
    mapa = L.map("mapa", {
      center: CENTRO_FALLBACK,
      zoom: ZOOM_INICIAL,
      maxZoom: ZOOM_MAX,
      zoomControl: false,
      preferCanvas: true, // crítico: renderiza os ~8800 polígonos em canvas,
      // não como elementos DOM individuais (SVG), o que
      // engasgaria o navegador com esse volume de feições.
    });

    L.control.zoom({ position: "bottomright" }).addTo(mapa);
    camadaNumeros = L.layerGroup().addTo(mapa);
    mapa.on("moveend zoomend", atualizarNumeros);
    document.getElementById("mostrarNumeros").addEventListener("change", atualizarNumeros);

    // Acesso XYZ utilizado pelo HCMGIS; não é a API oficial do Google Maps.
    const google = L.tileLayer("https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}", {
      maxZoom: ZOOM_MAX,
      maxNativeZoom: 19,
      attribution: 'Imagens &copy; <a href="https://maps.google.com" target="_blank" rel="noopener">Google</a>',
    });
    const esri = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: ZOOM_MAX,
      maxNativeZoom: 19,
      attribution:
        'Imagens &copy; <a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9" target="_blank" rel="noopener">Esri World Imagery</a> — Esri, Vantor, Earthstar Geographics e GIS User Community',
    });
    google.addTo(mapa);
    let baseAtual = google;
    const seletor = document.getElementById("mapaBase");
    seletor.addEventListener("change", function () {
      mapa.removeLayer(baseAtual);
      baseAtual = seletor.value === "google" ? google : esri;
      baseAtual.addTo(mapa);
      document.getElementById("avisoMapa").hidden = true;
    });
    [google, esri].forEach((base) => base.on("tileerror", function () {
      if (base !== baseAtual) return;
      const aviso = document.getElementById("avisoMapa");
      aviso.hidden = false;
      aviso.textContent = "Algumas imagens não carregaram. Confira a conexão ou escolha o outro mapa de fundo.";
    }));
  }

  // ---------- Classificação de status de um lote ----------

  function statusDoLote(props) {
    if (props.inconsistente_flag) return "inconsistente";
    const temRua = textoValido(props.rua);
    const temNumero = textoValido(props.numero);
    const temBairro = textoValido(props.bairro);
    if (temRua && temNumero && temBairro) return "completo";
    return "incompleto";
  }

  function textoValido(v) {
    return typeof v === "string" && v.trim() !== "";
  }

  function corDoStatus(status) {
    return CORES[status] || CORES.incompleto;
  }

  // ---------- Estilo dos polígonos ----------

  function estiloLote(feature) {
    if (gruposAtivos.size) {
      const marcado = idsAgrupamento.has(feature.properties.__id);
      return marcado
        ? { color: "#ffffff", weight: 2, opacity: 1, fillColor: "#e00000", fillOpacity: 0.65 }
        : { color: "#ffffff", weight: 0.6, opacity: 0.25, fillColor: "#e00000", fillOpacity: 0.03 };
    }
    if (idsBusca.has(feature.properties.__id)) {
      return { color: "#ffffff", weight: 2, opacity: 1,
        fillColor: "#e00000", fillOpacity: 0.65 };
    }
    return {
      color: "#ffffff",
      weight: 1.2,
      opacity: 1,
      fillColor: "#e00000",
      fillOpacity: idsBusca.size ? 0.08 : 0.35,
    };
  }

  function estiloSelecionado() {
    return {
      color: "#ffffff",
      weight: 3,
      opacity: 1,
      fillColor: "#e00000",
      fillOpacity: 0.8,
    };
  }

  // ---------- Carregamento dos dados ----------

  function carregarDados() {
    // O pacote para download inclui os dados como script para permitir
    // abrir index.html com dois cliques, sem um servidor local.
    const dados = window.LOTES_CADASTRAIS
      ? Promise.resolve(window.LOTES_CADASTRAIS)
      : fetch(URL_DADOS)
      .then((resp) => {
        if (!resp.ok) {
          throw new Error("HTTP " + resp.status + " ao buscar " + URL_DADOS);
        }
        return resp.json();
      });
    return dados
      .then((geojson) => {
        const info = document.getElementById("atualizacaoDados");
        if (geojson.metadata) {
          const meta = geojson.metadata;
          info.textContent = "Dados atualizados em " + new Date(meta.atualizado_em).toLocaleString("pt-BR")
            + " · " + meta.lotes_importados.toLocaleString("pt-BR") + " lotes";
          if (meta.registros_sem_geometria.length) {
            info.textContent += " · " + meta.registros_sem_geometria.length + " registros sem geometria";
          }
        } else {
          info.textContent = "Cadastro sem data de atualização registrada";
        }
        montarCamadaLotes(geojson);
        montarIndiceBusca(geojson);
        atualizarAgrupamentos();
        ajustarVisaoInicial(geojson);
        const termo = document.getElementById("inputBusca").value.trim();
        if (termo) executarBusca(termo);
      })
      .catch((erro) => {
        console.error("Falha ao carregar dados da planta cadastral:", erro);
        mostrarErroCarregamento();
      });
  }

  function mostrarErroCarregamento() {
    const caixa = document.getElementById("caixaBusca");
    const input = document.getElementById("inputBusca");
    input.placeholder = "Não foi possível carregar os dados do mapa";
    input.disabled = true;
    caixa.style.opacity = "0.6";
  }

  let proximoId = 0;

  function montarCamadaLotes(geojson) {
    camadaLotes = L.geoJSON(geojson, {
      style: estiloLote,
      onEachFeature: function (feature, layer) {
        const id = proximoId++;
        feature.properties.__id = id;
        featuresPorId.set(id, { feature, layer });
        const texto = numeroDoRotulo(feature.properties);
        if (texto) rotulosNumeros.push({ id, texto, posicao: layer.getBounds().getCenter() });

        layer.on("click", function () {
          selecionarLote(id, { centralizar: false });
        });
        layer.on("mouseover", function () {
          layer.bindTooltip(montarConteudoPopup(feature.properties), {
            sticky: true,
            direction: "top",
            offset: [0, -4],
            className: "popup-lote",
          });
          layer.openTooltip();
        });
        layer.on("mouseout", function () {
          layer.closeTooltip();
        });
      },
    }).addTo(mapa);
  }

  function montarConteudoPopup(props) {
    const rua = textoValido(props.rua) ? props.rua : null;
    const numero = textoValido(props.numero) ? props.numero : null;
    const bairro = textoValido(props.bairro) ? props.bairro : null;

    let linhaPrincipal;
    if (rua) {
      linhaPrincipal = rua + (numero ? ", " + numero : "");
    } else if (numero) {
      linhaPrincipal = "Nº " + numero;
    } else {
      linhaPrincipal = "Endereço não informado";
    }

    const linhaSecundaria = bairro || "Bairro não informado";

    const div = document.createElement("div");
    const p1 = document.createElement("div");
    p1.className = "linha-principal";
    p1.textContent = linhaPrincipal;
    const p2 = document.createElement("div");
    p2.className = "linha-secundaria";
    p2.textContent = linhaSecundaria;
    div.appendChild(p1);
    div.appendChild(p2);
    return div;
  }

  function ajustarVisaoInicial(geojson) {
    if (camadaLotes && geojson.features && geojson.features.length > 0) {
      mapa.fitBounds(camadaLotes.getBounds(), { padding: [20, 20] });
    }
  }

  // ---------- Índice de busca (fuzzy) ----------

  function normalizarTexto(texto) {
    return String(texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function normalizarLocal(texto) {
    return normalizarTexto(texto)
      .replace(/^(bairro|rua|r|avenida|av|travessa|tv|praca|pc)\s+/, "");
  }

  function montarIndiceBusca(geojson) {
    const registros = geojson.features.map((f) => ({
      id: f.properties.__id,
      busca: normalizarTexto(f.properties.busca),
      rua: f.properties.rua || "",
      numero: f.properties.numero || "",
      numero2: f.properties.numero2 || "",
      bairro: f.properties.bairro || "",
      nome: f.properties.nome || "",
    }));
    registrosBusca = registros;

    fuse = new Fuse(registros, {
      keys: [
        { name: "busca", weight: 1 },
      ],
      threshold: 0.38, // tolerância a erro de digitação (0 = exato, 1 = tudo)
      distance: 60,
      ignoreLocation: true,
      minMatchCharLength: 2,
      includeScore: true,
    });
  }

  // ---------- Interação de busca (UI) ----------

  const MAX_RESULTADOS = 25;
  let indiceDestacado = -1;
  let resultadosAtuais = [];

  function inicializarBuscaUI() {
    const input = document.getElementById("inputBusca");
    const caixa = document.getElementById("caixaBusca");
    const botaoLimpar = document.getElementById("botaoLimpar");
    const lista = document.getElementById("listaResultados");

    input.addEventListener("input", function () {
      const termo = input.value.trim();
      caixa.classList.toggle("tem-texto", termo.length > 0);
      if (termo.length === 0) {
        limparBusca();
        return;
      }
      executarBusca(termo);
    });

    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        limparBusca();
        return;
      }
      if (!lista.classList.contains("visivel")) return;
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        moverDestaque(1);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        moverDestaque(-1);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (indiceDestacado >= 0 && resultadosAtuais[indiceDestacado]) {
          escolherResultado(resultadosAtuais[indiceDestacado].item.id);
        } else if (buscaColetiva) {
          enquadrarBusca();
          esconderResultados();
        } else if (resultadosAtuais.length > 0) {
          escolherResultado(resultadosAtuais[0].item.id);
        }
      } else if (ev.key === "Escape") {
        limparBusca();
      }
    });

    botaoLimpar.addEventListener("click", function () {
      limparBusca();
      input.focus();
    });
    document.getElementById("verTodosBusca").addEventListener("click", enquadrarBusca);

    document.addEventListener("click", function (ev) {
      const painel = document.querySelector(".painel-busca");
      if (!painel.contains(ev.target)) {
        esconderResultados();
      }
    });
  }

  function limparBusca() {
    const input = document.getElementById("inputBusca");
    const caixa = document.getElementById("caixaBusca");
    input.value = "";
    caixa.classList.remove("tem-texto");
    fecharPainelDetalhes();
    buscaColetiva = false;
    marcarResultados([]);
    document.getElementById("resumoBusca").hidden = true;
    esconderResultados();
  }

  function buscarGrupo(termo) {
    const texto = normalizarTexto(termo);
    const nome = normalizarLocal(termo);
    if (nome.length < 2) return [];
    const campos = /^(bairro)\s/.test(texto) ? ["bairro"]
      : /^(rua|r|avenida|av|travessa|tv|praca|pc)\s/.test(texto) ? ["rua"]
      : ["bairro", "rua"];
    // Correspondência exata tem prioridade para não incluir locais de nome parecido.
    const exatos = registrosBusca.filter((r) => campos.some((c) => normalizarLocal(r[c]) === nome));
    if (exatos.length) return exatos;
    return registrosBusca.filter((r) => campos.some((c) =>
      (" " + normalizarLocal(r[c]) + " ").includes(" " + nome + " ")));
  }

  function marcarResultados(resultados) {
    idsBusca = new Set(resultados.map((r) => r.item.id));
    atualizarAgrupamentos();
  }

  function enquadrarBusca() {
    if (!idsBusca.size) return;
    const bounds = L.latLngBounds([]);
    idsBusca.forEach((id) => bounds.extend(featuresPorId.get(id).layer.getBounds()));
    mapa.fitBounds(bounds, { padding: [40, 80], maxZoom: 18 });
  }

  function executarBusca(termo) {
    if (!fuse) return;
    fecharPainelDetalhes();
    const grupo = buscarGrupo(termo);
    buscaColetiva = grupo.length > 0;
    const resultados = buscaColetiva ? grupo.map((item) => ({ item }))
      : fuse.search(normalizarTexto(termo), { limit: MAX_RESULTADOS });
    marcarResultados(buscaColetiva ? resultados : []);
    const resumo = document.getElementById("resumoBusca");
    resumo.hidden = !buscaColetiva;
    document.getElementById("totalBusca").textContent =
      grupo.length + (grupo.length === 1 ? " lote marcado" : " lotes marcados");
    if (buscaColetiva) enquadrarBusca();
    resultadosAtuais = resultados.slice(0, MAX_RESULTADOS);
    indiceDestacado = -1;
    renderizarResultados(resultadosAtuais, termo, resultados.length);
  }

  function renderizarResultados(resultados, termo, total) {
    const lista = document.getElementById("listaResultados");
    lista.innerHTML = "";
    lista.classList.add("visivel");

    if (resultados.length === 0) {
      const vazio = document.createElement("div");
      vazio.className = "resultado-vazio";
      vazio.textContent = "Nenhum lote encontrado para “" + termo + "”.";
      lista.appendChild(vazio);
      return;
    }

    const contador = document.createElement("div");
    contador.className = "contador-resultados";
    contador.textContent = buscaColetiva
      ? total + " lotes marcados no mapa" + (total > MAX_RESULTADOS ? " · primeiros 25 na lista" : "")
      : resultados.length === 1
        ? "1 resultado"
        : resultados.length + " resultados" + (resultados.length >= MAX_RESULTADOS ? " (mostrando os mais relevantes)" : "");
    lista.appendChild(contador);

    resultados.forEach((resultado, i) => {
      const item = resultado.item;
      const el = document.createElement("div");
      el.className = "item-resultado";
      el.setAttribute("role", "option");
      el.dataset.indice = String(i);

      const { feature } = featuresPorId.get(item.id);
      const status = statusDoLote(feature.properties);

      const ponto = document.createElement("span");
      ponto.className = "ponto-status " + status;

      const texto = document.createElement("div");
      texto.className = "texto-resultado";

      const principal = document.createElement("div");
      principal.className = "linha-principal";
      principal.textContent = montarLinhaPrincipal(item);

      const secundaria = document.createElement("div");
      secundaria.className = "linha-secundaria";
      secundaria.textContent = montarLinhaSecundaria(item);

      texto.appendChild(principal);
      texto.appendChild(secundaria);
      el.appendChild(ponto);
      el.appendChild(texto);

      el.addEventListener("click", function () {
        escolherResultado(item.id);
      });
      el.addEventListener("mouseenter", function () {
        indiceDestacado = i;
        atualizarDestaqueVisual();
      });

      lista.appendChild(el);
    });
  }

  function montarLinhaPrincipal(item) {
    if (item.rua) return item.rua + (item.numero ? ", " + item.numero : "");
    if (item.nome) return item.nome;
    if (item.numero) return "Nº " + item.numero;
    return "Endereço sem rua identificada";
  }

  function montarLinhaSecundaria(item) {
    const partes = [];
    if (item.bairro) partes.push(item.bairro);
    if (item.nome && item.rua) partes.push(item.nome);
    return partes.length > 0 ? partes.join(" · ") : "Sem bairro informado";
  }

  function moverDestaque(delta) {
    if (resultadosAtuais.length === 0) return;
    indiceDestacado =
      (indiceDestacado + delta + resultadosAtuais.length) % resultadosAtuais.length;
    atualizarDestaqueVisual();
  }

  function atualizarDestaqueVisual() {
    const itens = document.querySelectorAll(".item-resultado");
    itens.forEach((el) => el.classList.remove("destacado"));
    if (indiceDestacado >= 0 && itens[indiceDestacado]) {
      itens[indiceDestacado].classList.add("destacado");
      itens[indiceDestacado].scrollIntoView({ block: "nearest" });
    }
  }

  function esconderResultados() {
    const lista = document.getElementById("listaResultados");
    lista.classList.remove("visivel");
    lista.innerHTML = "";
    resultadosAtuais = [];
    indiceDestacado = -1;
  }

  function escolherResultado(id) {
    esconderResultados();
    selecionarLote(id, { centralizar: true });
  }

  // ---------- Seleção de lote (mapa + painel de detalhes) ----------

  function selecionarLote(id, opcoes) {
    const entrada = featuresPorId.get(id);
    if (!entrada) return;
    const { feature, layer } = entrada;

    // Restaura o estilo do lote selecionado anteriormente
    if (layerSelecionado && layerSelecionado !== layer) {
      camadaLotes.resetStyle(layerSelecionado);
    }

    layer.setStyle(estiloSelecionado());
    if (layer.bringToFront) layer.bringToFront();
    layerSelecionado = layer;

    if (opcoes && opcoes.centralizar) {
      const bounds = layer.getBounds();
      mapa.flyToBounds(bounds, {
        padding: [120, 120],
        maxZoom: 19,
        duration: 0.6,
      });
    }

    abrirPainelDetalhes(feature.properties);
  }

  function abrirPainelDetalhes(props) {
    const painel = document.getElementById("painelDetalhes");
    const conteudo = document.getElementById("conteudoDetalhes");
    conteudo.innerHTML = "";

    const status = statusDoLote(props);
    const rotuloStatus = {
      completo: "Endereço completo",
      incompleto: "Incompleto",
      inconsistente: "Inconsistente",
    }[status];

    const badge = document.createElement("div");
    badge.className = "detalhes-status " + status;
    const ponto = document.createElement("span");
    ponto.className = "ponto-status " + status;
    badge.appendChild(ponto);
    badge.appendChild(document.createTextNode(rotuloStatus));
    conteudo.appendChild(badge);

    const titulo = document.createElement("h2");
    titulo.className = "detalhes-titulo";
    titulo.textContent = textoValido(props.rua)
      ? props.rua
      : textoValido(props.nome)
      ? props.nome
      : "Lote sem identificação";
    conteudo.appendChild(titulo);

    const subtitulo = document.createElement("div");
    subtitulo.className = "detalhes-subtitulo";
    subtitulo.textContent = textoValido(props.bairro)
      ? props.bairro
      : "Bairro não informado";
    conteudo.appendChild(subtitulo);

    adicionarCampo(conteudo, "Rua", props.rua);
    adicionarCampo(conteudo, "Número", props.numero);
    adicionarCampo(conteudo, "Número (complemento)", props.numero2);
    adicionarCampo(conteudo, "Bairro", props.bairro);
    adicionarCampo(conteudo, "Nome / referência", props.nome);
    adicionarCampo(conteudo, "Inconsistência", props.inconsiste);

    painel.classList.add("aberto");
  }

  function adicionarCampo(container, rotulo, valor) {
    const div = document.createElement("div");
    div.className = "campo-detalhe";

    const r = document.createElement("div");
    r.className = "rotulo";
    r.textContent = rotulo;

    const v = document.createElement("div");
    const preenchido = textoValido(valor);
    v.className = "valor" + (preenchido ? "" : " vazio");
    v.textContent = preenchido ? valor : "Não informado";

    div.appendChild(r);
    div.appendChild(v);
    container.appendChild(div);
  }

  function fecharPainelDetalhes() {
    document.getElementById("painelDetalhes").classList.remove("aberto");
    if (layerSelecionado) {
      camadaLotes.resetStyle(layerSelecionado);
      layerSelecionado = null;
    }
  }

  function inicializarPainelDetalhes() {
    document
      .getElementById("fecharDetalhes")
      .addEventListener("click", fecharPainelDetalhes);
  }

  // ---------- Boot ----------

  document.addEventListener("DOMContentLoaded", function () {
    criarMapa();
    inicializarBuscaUI();
    inicializarPainelDetalhes();
    inicializarAgrupamentos();
    carregarDados();
  });
})();
