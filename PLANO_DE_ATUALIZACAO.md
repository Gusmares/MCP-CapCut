# Plano de Atualização — capcut-mcp

> Documento de limitações conhecidas e correções recomendadas para o servidor MCP `capcut-mcp` (`src/core.js` + `src/server.js`), a partir da investigação e das tentativas de correção feitas no draft `EVOE_teste_nativo_vertical_v3`. Serve como guia para uma próxima rodada de manutenção do código, não é um changelog do que já foi entregue ao cliente final do vídeo.

## ✅ Status desta rodada de manutenção (aplicado logo após este documento ser escrito)

Os itens abaixo foram corrigidos no código, validados com um clone real do `EVOE_teste_nativo_vertical_v3` (nunca o original) reproduzindo exatamente o cenário do item 1 (segmento começando aos 12s), e cobertos por testes automatizados:

- **Item 1 (crítico) — corrigido.** `addKeyframe()` agora recebe `atSec` **absoluto na timeline** (mesma convenção de todas as outras tools) e converte internamente pra `time_offset` relativo ao início do segmento, rejeitando com erro claro qualquer tempo fora do intervalo do segmento — quem chama a tool não precisa mais fazer essa conta manualmente, e não tem mais como repetir o erro descrito aqui silenciosamente.
- **Item 2 — corrigido.** `validate()` agora percorre `common_keyframes[].keyframe_list[].time_offset` de todo segmento e reporta `issues` se algum estiver fora de `[0, duração do segmento]` — rede de segurança mesmo para um keyframe inserido via `capcut_raw_patch`.
- **Item 3 (persistência do audio_fade) — não reproduzido, mas rede de segurança adicionada.** `validate()` agora também: (a) reporta `issues` se algum `extra_material_refs` apontar pra um material inexistente (pegaria exatamente o sintoma "fade sumiu" descrito aqui, seja qual for a causa raiz), e (b) avisa em `warnings` sobre um `audio_fade` órfão (existe mas nenhum segmento referencia). A causa raiz descrita no item 3 (condição de corrida vs. save bloqueado por lock) segue não confirmada — não foi reproduzida nesta rodada.
- **Item 4 (mute de track) — corrigido.** Nova tool `capcut_set_track_mute(draft, trackIndex, muted)`, e `capcut_read_timeline` agora devolve `muted: boolean` por track.
- **Item 8 (aviso de CapCut aberto) — corrigido.** `capcut_read_timeline` agora inclui um campo `warning` visível e explícito quando `locked` ou `capcutRunning` é verdadeiro, em vez de só os dois campos crus que exigiam o chamador saber interpretar.

**Itens 5, 6 e 7 permanecem como estão descritos abaixo** — item 6 (legendas automáticas) está sendo endereçado por um plano de ação separado e mais amplo (transcrição + presets de estilo por segmento de negócio); itens 5 e 7 seguem como limitação de arquitetura / hipótese não confirmada, respectivamente, sem mudança de código nesta rodada.

## Resumo executivo

- **Bug mais grave e mais barato de corrigir:** `capcut_add_keyframe` usa `atSec` como tempo *relativo ao início do segmento*, enquanto todas as outras tools de timeline (`trim`, `split`, `move`, `add_video/text/audio`) usam tempo *absoluto* na timeline. Essa inconsistência de API já causou um zoom quebrado em produção (segmento `3D61684C`, ver item 1) e não é sinalizada em lugar nenhum — nem na descrição da tool, nem pelo `capcut_validate`.
- **Rede de segurança incompleta:** `capcut_validate()` (`src/core.js`, método `validate()`) não verifica limites de `common_keyframes[].keyframe_list[].time_offset`, duração de transição pedida vs. gravada, nem nada relacionado a fades de áudio — ele só cobre materiais duplicados, sobreposição de segmentos e mídia ausente. Um `capcut_save` "passa limpo" mesmo com um keyframe que nunca vai disparar.
- **Bug de persistência — CONFIRMADO e contornado (mas ainda vale corrigir na raiz):** depois que o CapCut foi fechado, `capcut_add_audio_fade` foi chamado de novo em duas rodadas separadas (não em paralelo com nenhuma outra tool call) e desta vez **persistiu corretamente** em disco (`materials.audio_fades` com 2 entradas, refs corretas nos segmentos). Isso indica fortemente que a causa raiz era mesmo uma condição de corrida: as duas chamadas de fade da primeira tentativa foram disparadas na mesma rodada paralela junto com 8 outras tool calls (4 transições + 4 keyframes), e mesmo o servidor sendo single-threaded, alguma interação entre chamadas concorrentes na mesma sessão fez o merge final perder essas duas mutações especificamente. Recomendação: mesmo funcionando quando isolado, isso é frágil — vale investigar se `wrap()`/o dispatch de tools em `server.js` tem algum ponto onde chamadas emitidas na mesma rodada podem operar sobre snapshots de `this.content` que não são a mesma referência (ex.: alguma cópia acontecendo em outro lugar não coberto por esta leitura de código), e no mínimo documentar explicitamente para quem for chamar a API: evite disparar muitas mutações no mesmo draft em paralelo no mesmo turno; prefira sequencial quando o número de chamadas for grande.
- **Limitação estrutural, não bug:** não existe nenhuma forma de renderizar/exportar a timeline fora de abrir o CapCut manualmente — isso torna impossível fazer QA automatizado do resultado visual final (transições, keyframes, filtros aplicados) sem intervenção humana a cada rodada.
- **Feature ausente:** legendas automáticas (`capcut_add_text` em lote a partir de um transcript) não funcionam hoje em nenhum draft do projeto — falta um draft-template com `materials.texts` e falta qualquer ferramenta de ASR conectada nesta sessão.

### Estado atual do draft `EVOE_teste_nativo_vertical_v3`

| Item | Estado |
|---|---|
| Zoom do segmento `3D61684C` (f5, keyframes `UNIFORM_SCALE`) | **Corrigido e confirmado em disco** — `time_offset` 0 e 20000000 (relativo, dentro da duração de 20s do segmento), valores 1.0 → 1.12. |
| Fade de áudio clip0 (fade-in 0.3s) e clip3 (fade-out 0.6s) | **Corrigido e confirmado em disco** — `materials.audio_fades` com 2 entradas (`fade_in_duration: 300000`, `fade_out_duration: 600000`), refs corretas em `extra_material_refs` dos dois segmentos. |
| `tracks[0].attribute` (mute) | Não alterado; confirmado em `0` (não-mudo) no arquivo final. |
| `capcut_validate` | Passou sem erros (só o warning inócuo de `render_index` compartilhado). |
| `capcut_save` | **Concluído com sucesso** após o usuário fechar o CapCut. Houve uma tentativa intermediária bloqueada por `draft was modified on disk since this session loaded it` (o CapCut salvou mais uma vez ao fechar) — a sessão foi descartada e recarregada do zero antes de reaplicar as correções, sem usar `force:true`, para não arriscar sobrescrever esse último salvamento do usuário. |
| Estrutura da timeline | O usuário editou no CapCut aberto durante a investigação: os segmentos `f1`–`f4` (4 clipes) viraram um único segmento novo `MPR 19-07 - EVOE 01 (1).mp4`. Essa edição do usuário foi preservada — as correções foram aplicadas por cima dela, não sobre a estrutura antiga de 9 segmentos. |

**Estado final:** todas as correções planejadas para este draft foram aplicadas e confirmadas por leitura direta do `draft_content.json` salvo. O item de persistência do fade de áudio (acima) segue como recomendação de robustez para o código, mas não é mais um bloqueio prático.

---

## 1. Ambiguidade relativo-vs-absoluto em `capcut_add_keyframe` (`atSec`)

**Prioridade: Alta**

**O que acontece:** um keyframe de animação (zoom, posição, rotação etc.) criado com `capcut_add_keyframe` simplesmente não anima — o valor fica estático, como se a tool não tivesse feito nada, mesmo a chamada retornando sucesso.

**Causa raiz:** em `src/server.js`, a tool `capcut_add_keyframe` (linha 112–114) documenta `atSec` apenas como "a time" e repassa o valor cru para `addKeyframe()` em `src/core.js` (linha 336–351), que grava esse valor em `keyframe_list[].time_offset` sem nenhuma conversão. Pesquisa em duas implementações de referência do formato CapCut/JianYing (pyJianYingDraft e o fork VectCutAPI, ambas com a mesma classe `Keyframe`) confirma que `time_offset` é **relativo ao início do material/segmento**, nunca absoluto na timeline. Isso contraria a convenção de todas as outras tools de tempo do próprio capcut-mcp — `capcut_trim_segment`, `capcut_split_segment`, `capcut_move_segment`, `capcut_add_video/image/audio/text` — que usam `atSec` como tempo **absoluto** na timeline (confirma-se lendo `timeline()` em `core.js`, que reporta `atSec` como `target_timerange.start / US`). Ou seja, a mesma palavra de parâmetro (`atSec`) significa duas coisas diferentes dependendo da tool, sem aviso na assinatura nem na descrição.

**Evidência:** no draft `EVOE_teste_nativo_vertical_v3`, o segmento `3D61684C` (`f5_44_64.mp4`, começa em 32s absolutos da timeline, dura 20s local) recebeu keyframes com `atSec=32` e `atSec=52` (tempos absolutos, por engano). O `draft_content.json` gravou `time_offset=32000000` e `52000000` (microssegundos) num segmento cuja `source_timerange.duration` é `20000000` — ambos os valores caem fora do intervalo válido `[0, 20000000]`, então a animação nunca é alcançada durante a reprodução do clipe. Por coincidência, um keyframe anterior no segmento `F58661E4` (que começa em `t=0` da timeline) funcionou, porque `atSec` absoluto e relativo coincidem quando o segmento começa em zero — o que mascarou o bug até ele aparecer num segmento que não começa em zero.

**Correção recomendada:**
- **Código:** em `src/server.js`, mudar a assinatura de `capcut_add_keyframe` para deixar explícito que o tempo é relativo ao segmento — por exemplo renomear o parâmetro de `atSec` para `atSecFromSegmentStart` (ou manter `atSec` mas com `.describe('tempo RELATIVO ao início deste segmento/material, em segundos — 0 = início do clipe, diferente de todas as outras tools de tempo desta API, que usam tempo absoluto na timeline')`). Idealmente, aceitar também um `atSecAbsolute` opcional em `src/core.js` (`addKeyframe`) que subtraia `s.target_timerange.start` automaticamente, evitando obrigar quem chama a tool a fazer a conta manualmente e reduzindo a chance de repetir o erro.
- **Sem quebrar compatibilidade:** se preferir não mudar o nome do parâmetro, ao menos adicionar uma validação (ver item 2) que rejeite/avise quando `atSec` (convertido para `time_offset`) cair fora de `[0, duração local do segmento]` — isso pega o erro no ato, independente de qual convenção o chamador assumiu.

---

## 2. `capcut_validate` não detecta `time_offset` de keyframe fora do range do segmento

**Prioridade: Alta**

**O que acontece:** um draft com keyframes inválidos (fora do intervalo de duração do segmento) passa por `capcut_validate` sem nenhum erro ou aviso, e o `capcut_save` também não bloqueia — o problema só é percebido visualmente, depois, dentro do próprio CapCut.

**Causa raiz:** o método `validate()` em `src/core.js` (linha 464–484) cobre apenas três classes de problema: materiais duplicados (`dupMat`), sobreposição de segmentos/`render_index` (`overlaps`, `riClash`) e arquivo de mídia ausente (`missing media file`). Não existe nenhuma checagem que percorra `s.common_keyframes[].keyframe_list[].time_offset` e compare com `s.target_timerange.duration` (ou `source_timerange.duration`).

**Evidência:** o `capcut_validate` rodado sobre o draft já com os keyframes corretos (0s/20000000µs) e, antes disso, com os keyframes quebrados (32000000/52000000µs) retornaria exatamente o mesmo resultado (`ok: true`, sem issues) — porque nenhuma das duas validações existentes toca nesse campo. Isso foi inferido diretamente da leitura do código de `validate()`, que não menciona `common_keyframes` em nenhuma linha.

**Correção recomendada:** adicionar ao `validate()` em `src/core.js` um laço que, para cada segmento com `common_keyframes`, valide `0 <= time_offset <= (s.source_timerange?.duration ?? s.target_timerange.duration)` para cada `keyframe_list[i]`, e empurre para `issues` uma mensagem como:
```
`keyframe fora do range no segmento ${s.id} (property ${list.property_type}): time_offset=${kf.time_offset/US}s, duração local do segmento=${dur/US}s`
```
Isso transforma o bug 1 (e qualquer recorrência dele) num erro que impede o `capcut_save` de completar sem `force:true`, em vez de um defeito silencioso só visível reabrindo o CapCut.

---

## 3. `capcut_add_audio_fade` não persiste em disco

**Prioridade: Alta**

**O que acontece:** o usuário pede fade-in/fade-out num clipe de áudio, a tool retorna sucesso (ecoando os valores pedidos), mas o fade não aparece no vídeo final — porque nunca chega a existir no `draft_content.json`.

**Causa raiz:** não confirmada nesta rodada. A leitura estática de `addAudioFade()` em `src/core.js` (linha 361–375) está correta: cria (ou reaproveita) um material `audio_fade` com os 5 campos esperados pelo formato CapCut/JianYing (`id`, `fade_in_duration`, `fade_out_duration`, `fade_type`, `type`), dá `push` em `this._mats('audio_fades')` e adiciona o `id` em `s.extra_material_refs`. Não há, no restante de `core.js`, nenhum ponto que reconstrua `content.materials` do zero a partir dos segmentos (diferente do que a lib de referência VectCutAPI faz — lá, a agregação em `materials.audio_fades` só acontece quando o segmento é adicionado ao script, o que seria um risco real se este projeto tivesse uma etapa parecida; não tem). Como o objeto `CapCutDraft` é cacheado por nome em `open` (`src/server.js` linha 13–14) e todo o resto das operações mutam o mesmo `this.content` em memória de forma síncrona (sem `await` no meio da função), uma condição de corrida clássica entre chamadas paralelas da própria tool também não é o mais provável.
A explicação alternativa mais plausível, ainda não descartada: nas duas vezes em que o fade foi testado, o `capcut_save` acabou bloqueado pelo lock do CapCut (ver item 8) antes de gravar em disco — então o "fade sumiu" pode simplesmente ser reflexo de **nenhum save real ter completado**, e o arquivo em disco continuar refletindo o estado interno do CapCut aberto (que nunca recebeu o fade).

**Evidência:** na fase de investigação original, o fade foi aplicado em `clip0`/`clip3`, a tool retornou sucesso, mas `materials.audio_fades` ficou vazio tanto logo após o save quanto após o autosave do CapCut. Na tentativa de reproduzir isoladamente (chamada única, sem paralelismo) feita nesta rodada, o `capcut_save` foi bloqueado por `.locked` antes de qualquer gravação — então o teste isolado não pôde nem confirmar nem descartar a hipótese original de condição de corrida; só ficou provado que, com o save bloqueado, nada persiste (o que já era esperado).

**Correção recomendada:**
1. **Teste determinístico primeiro, sem mudar código:** com o CapCut fechado (sem `.locked`), rodar `capcut_add_audio_fade` sozinho (sem nenhuma outra tool call na mesma rodada), imediatamente `capcut_save` (sem `force:true`), e inspecionar `draft_content.json` no disco (`materials.audio_fades.length` e o `extra_material_refs` do segmento). Isso finalmente isola a variável "paralelismo" da variável "save nunca completou".
2. Se mesmo assim o fade sumir: instrumentar `addAudioFade()` com um log temporário (`console.error`) imprimindo `this.content.materials.audio_fades.length` logo após o `push`, e comparar com o que `save()` de fato serializa (`JSON.stringify(this.content)`) — para garantir que não há duas instâncias de `CapCutDraft` para o mesmo draft (checar se `get()` em `server.js` está sempre resolvendo a mesma chave de `open`, inclusive quando o nome do draft é passado com variações de maiúsculas/espaços).
3. Adicionar ao `capcut_validate` uma checagem de consistência: todo `id` de `audio_fade` referenciado em algum `extra_material_refs` deve existir em `materials.audio_fades`, e vice-versa — isso pegaria esse tipo de perda de dado antes do save, não só depois.

---

## 4. Herança silenciosa do mute da track (`attribute`) em drafts clonados

**Prioridade: Média**

**O que acontece:** o usuário reclama que "o vídeo está sem som", mesmo com os clipes de vídeo tendo áudio original — sem que nenhuma ação do MCP tenha mexido em volume ou faixa de áudio.

**Causa raiz:** o campo `tracks[].attribute` no schema CapCut/JianYing é o mute da track (`"attribute": int(self.mute)` nas duas implementações de referência consultadas — não é lock nem visibilidade, que são campos separados). `capcut_clone_draft` (`cloneDraft()`, `src/core.js` linha 506–523) copia o `draft_content.json` inteiro do draft-base, incluindo esse campo, sem nenhuma tool dedicada para inspecioná-lo ou alterá-lo depois — `capcut_set_props` (linha 92–96 de `server.js`) mexe em volume por segmento, não no mute da track inteira. Se o draft-base usado como template para `capcut_clone_draft` tiver a track de vídeo com `attribute=1` (mudo), todo draft clonado a partir dele nasce mudo, silenciosamente.

**Evidência:** no draft original e em todos os drafts irmãos `EVOE_teste_nativo_*`, `tracks[0].attribute` era `1` — sistemático, herdado do mesmo template usado por `capcut_clone_draft`, não uma ação pontual de nenhuma tool. Depois que o usuário abriu o CapCut e ele salvou automaticamente por conta própria, o campo virou `0` sozinho — indicando que foi o próprio motor do CapCut (ou uma ação da UI, como o usuário clicando no ícone de mute da track) que desmutou, não o MCP.

**Correção recomendada:**
- **Código:** adicionar uma tool nova, por exemplo `capcut_set_track_mute(draft, trackIndex | trackId, muted: boolean)`, que escreva diretamente `track.attribute = muted ? 1 : 0` em `src/core.js`. É uma adição pequena e isolada (mesmo padrão de `_resolveTrack` já existente).
- **Visibilidade:** expor `attribute` (renomeado para algo autoexplicativo, tipo `muted: boolean`) no retorno de `capcut_read_timeline` / `timeline()` (`core.js` linha 147–164), por track — hoje o método só devolve `type`, `name` e `segments`, então não dá para nem perceber que uma track está muda sem ler o JSON cru.
- **Processo:** ao criar/curar um draft-template para `capcut_clone_draft`, confirmar explicitamente que `tracks[].attribute` do template é `0` antes de adotá-lo como base — isso evita herdar o mute silenciosamente para todo draft novo.

---

## 5. Nenhuma forma de renderizar/pré-visualizar a timeline fora do próprio CapCut

**Prioridade: Média**

**O que acontece:** não há como confirmar, de forma automatizada, se transições, keyframes de zoom, filtros e máscaras aplicados via MCP realmente ficam bons no resultado final — a única forma de ver o vídeo montado de verdade é abrir o CapCut manualmente e reproduzir/exportar na UI.

**Causa raiz:** `src/server.js` não expõe nenhuma tool de export/render (não existe `capcut_export`, `capcut_render_preview` ou equivalente), e o próprio CapCut desktop não expõe uma função de export via linha de comando. O `ffmpeg.exe` bundlado com o CapCut (usado nesta investigação só para extrair frames estáticos com `ffprobe`/`ffmpeg -sseof`) não tem acesso ao projeto `.draft` — ele só processa arquivos de mídia crus, não entende `draft_content.json` (transições, keyframes, máscaras são conceitos do editor, não do container de vídeo).

**Evidência:** a QA visual feita nesta investigação (comparação de frames nos 8 pontos de corte da timeline) só pôde avaliar a continuidade do material bruto (últimos/primeiros frames de cada arquivo-fonte), não o resultado com transições/zoom/filtros já aplicados pelo motor de render do CapCut — limitação documentada explicitamente pela própria investigação anterior.

**Correção recomendada (não é um bug de código, é uma lacuna de arquitetura — vale investir só se o time achar que compensa o custo):**
- Investigar se o CapCut desktop aceita algum modo headless/CLI de export (verificar changelogs/flags de linha de comando das versões instaladas; nem toda versão documenta isso publicamente).
- Alternativa mais realista: montar um pipeline de "preview aproximado" fora do CapCut, usando `ffmpeg` diretamente sobre os clipes-fonte + os parâmetros já conhecidos do `draft_content.json` (recortes, transições simples tipo dissolve, keyframes de escala) para gerar um MP4 de baixa fidelidade só para QA rápido — não seria pixel-perfect ao resultado do CapCut, mas destravaria verificação automatizada básica sem depender de abrir a UI a cada rodada.
- Enquanto nenhuma das duas opções acima existir, documentar explicitamente (no README do projeto e/ou na skill `capcut-reels`) que toda entrega precisa de uma checagem visual manual no CapCut antes de considerar o vídeo pronto — hoje isso depende de o operador lembrar, não é reforçado por nenhuma ferramenta.

---

## 6. Falta de suporte a legendas automáticas

**Prioridade: Média**

**O que acontece:** pedir para adicionar legendas automáticas a um vídeo falha, porque `capcut_add_text` não tem de onde copiar o estilo de texto, e não existe nenhum jeito de gerar as legendas (transcrição) a partir do áudio dentro desta sessão.

**Causa raiz:** dois problemas independentes, ambos de configuração/setup, não de lógica de código:
1. `addText()` em `src/core.js` (linha 215–244) precisa de um "template" de texto colhido de algum draft real (`this.templates().text`, populado por `harvest()`, linha 83–97) — se nenhum draft tiver uma camada de texto, a chamada falha com `no text template found. Set CAPCUT_TEMPLATE_DRAFT to a draft that contains a text layer.` (mensagem literal da linha 218). A variável de ambiente `CAPCUT_TEMPLATE_DRAFT` não está definida (cai no fallback hardcoded `'0723'`, linha 52, que não existe na pasta de drafts), e nenhum dos 5 drafts inspecionados (`EVOE`, `EVOE_teste_nativo_producao`, `_vertical`, `_v2`, `_v3`) tem `materials.texts` preenchido.
2. Não há nenhuma ferramenta de ASR/transcrição conectada nesta sessão. "WhisperFlow" aparece só como menção textual no `README.md` do projeto e na skill `capcut-reels/SKILL.md` (listada como dependência opcional), sem instalação, binário ou server MCP associado — `mcp.json.example` só registra o server `capcut`.

**Evidência:** checklist de investigação já executado nesta sessão confirma ambos os pontos: `printenv | grep -i capcut` vazio; `materials.texts.length === 0` nos 5 drafts; nenhum server MCP conectado hoje oferece transcrição de áudio; `ToolSearch` por termos de ASR não retornou nenhuma tool deferida.

**Correção recomendada (passo a passo de setup, não mudança de código):**
1. No CapCut, criar (ou reaproveitar) um draft dedicado a servir de template, adicionar manualmente uma camada de texto qualquer (conteúdo/fonte/posição são irrelevantes, só precisa existir em `materials.texts`), salvar e fechar o CapCut.
2. Apontar a variável de ambiente `CAPCUT_TEMPLATE_DRAFT` para o **nome da pasta** desse draft-template (não o caminho completo) na configuração real do MCP server (não só no `mcp.json.example`).
3. Reiniciar/reconectar o server MCP `capcut` depois de setar a env var — ela só é lida uma vez, no escopo do módulo (`process.env.CAPCUT_TEMPLATE_DRAFT || '0723'`, linha 52 de `core.js`), não recarrega em quente.
4. Validar isoladamente: inspecionar `draft_content.json` do template (`materials.texts.length > 0`) e rodar um `capcut_add_text` de teste antes de confiar no fluxo de legendas em produção.
5. Decidir e configurar uma ferramenta real de ASR — três caminhos possíveis, nenhum ainda avaliado: (a) server MCP de WhisperFlow, se existir e houver acesso (`claude mcp add whisperflow ...`, depois confirmar que aparecem tools `mcp__whisperflow__*`); (b) binário local tipo `whisper.cpp`/`faster-whisper` gerando `.srt`/`.vtt` a partir do áudio dos clipes; (c) API cloud de transcrição com credencial própria do usuário.
6. Depois de ter um transcript, formalizar o passo de conversão cue→`capcut_add_text`: para cada cue (`start`/`end` em segundos), chamar `capcut_add_text(text, atSec=start, durSec=end-start)` numa track de texto dedicada (`capcut_add_track type:'text'`), separada da track de vídeo — atenção que aqui `atSec` de `add_text` já é absoluto na timeline (comportamento correto, diferente do bug do item 1).

---

## 7. Duração de transição pedida diverge da persistida

**Prioridade: Baixa**

**O que acontece:** o usuário pede uma transição de, por exemplo, 0.3s, mas o valor gravado no draft final é diferente (~0.267s) — uma divergência pequena, mas consistente.

**Causa raiz:** não está em `core.js`. `addTransition()` (`src/core.js` linha 403–417) grava `duration: durationUs != null ? durationUs : t.defaultDurationUs` **literalmente**, sem nenhuma lógica de escala, arredondamento ou clamping. A mudança observada acontece depois, em algum momento entre a chamada da tool e a leitura do arquivo final — mais provavelmente o próprio motor/autosave do CapCut ajustando a duração da transição ao salvar, possivelmente porque os clipes-fonte não têm sobra de metragem além do range exato já usado nos dois lados do corte (uma transição do tipo dissolve/overlap consome frames extras de cada lado; sem esses frames sobrando, o CapCut pode estar comprimindo a duração pedida para caber no que existe).

**Evidência:** pedidos de `durationSec=0.3` e `0.15` (transições Dissolve e White Flash) resultaram em `duration=266666`µs e `133333`µs no arquivo final — ambos exatamente **8/9** do valor pedido, uma proporção fixa e repetida em dois pontos diferentes, o que é mais consistente com um ajuste sistemático do CapCut do que com um erro aleatório.

**Correção recomendada:**
- Confirmar a hipótese testando um caso onde os clipes-fonte tenham bastante sobra de metragem nas duas pontas do corte — se a duração for respeitada nesse caso, confirma que é limitação de metragem disponível, não um bug de escala fixo de 8/9.
- Se confirmado que é limitação de metragem: não há correção de código possível no capcut-mcp em si (a decisão é do motor do CapCut); o mais útil é a tool `capcut_add_transition` avisar no retorno quando a duração pedida for maior do que a sobra disponível nos dois clipes envolvidos (calculável a partir de `source_timerange` e da duração real do arquivo-fonte, via `probeDur`), em vez de o usuário só descobrir a divergência inspecionando o arquivo final depois do save.
- Se **não** for limitação de metragem (ou seja, a divergência acontecer mesmo com sobra de sinal disponível): vale then investigar se existe algum fator de conversão de frame-rate/timebase aplicado pelo CapCut ao normalizar durações para o `fps` do projeto — mas isso exigiria mais um teste controlado antes de qualquer mudança de código.

---

## 8. Risco de o autosave do CapCut sobrescrever edições feitas via MCP

**Prioridade: Alta**

**O que acontece (risco, não bug já confirmado neste projeto):** se o CapCut estiver aberto no mesmo draft que está sendo editado via MCP, o autosave do próprio app pode gravar por cima do `draft_content.json`, apagando (ou nunca deixando persistir) as edições feitas pelas tools MCP — inclusive depois de um `capcut_save` bem-sucedido, se o CapCut salvar novamente logo em seguida a partir do seu próprio estado em memória (que nunca soube das edições feitas por fora).

**Causa raiz:** o CapCut desktop, quando aberto num draft, mantém seu próprio estado em memória e salva periodicamente por conta própria — comportamento do app, fora do controle do MCP. O capcut-mcp já tem duas proteções implementadas em `save()` (`src/core.js` linha 487–502): (1) recusa salvar se existir `.locked` na pasta do draft, e (2) recusa salvar se detectar que `draft_content.json` foi modificado no disco desde que a sessão carregou (`onDiskMtimeMs !== this._loadedMtimeMs`) — ambas contornáveis com `force:true`. O risco residual que **não** é coberto: mesmo sem `force:true`, se o CapCut for reaberto pelo usuário **depois** de um `capcut_save` ter completado com sucesso (janela de tempo entre nosso save e o próximo autosave do CapCut), o app carrega o arquivo já atualizado, mas qualquer edição feita na UI a partir daí (incluindo autosaves periódicos) pode reverter/ignorar partes do que foi gravado via MCP se o CapCut reprocessar/normalizar certos campos ao carregar (é uma hipótese razoável para explicar o item 7, por exemplo).

**Evidência:** confirmado nesta investigação que o mecanismo de lock funciona como esperado — toda tentativa de `capcut_save` com o CapCut aberto (8 processos `CapCut.exe` rodando, `.locked` presente) foi corretamente bloqueada, sem que `force:true` tivesse sido usado em nenhum momento. Ou seja, a proteção existente já evitou dano nesta sessão. O risco documentado aqui é sobre o que acontece depois que o usuário fechar o CapCut e um save legítimo for feito — não há garantia de que reabrir o CapCut em seguida preserve tudo byte-a-byte, porque o próprio motor do CapCut pode "normalizar" o JSON ao carregá-lo (ver item 7, divergência de duração de transição, e o próprio `attribute` de mute que mudou sozinho de `1` para `0` depois de um autosave — item 4).

**Correção recomendada:**
- **Manter a política atual:** nunca usar `force:true` para contornar o lock — isso já está correto e deve continuar sendo a regra operacional padrão, documentada inclusive no README/skill.
- **Fechar o loop de verificação:** depois que o usuário fechar o CapCut e um `capcut_save` completar, recomenda-se **reabrir o CapCut uma vez, deixá-lo autosalvar, fechar de novo, e então reinspecionar o `draft_content.json`** comparando campo a campo com o que o MCP gravou — só assim dá para saber se o CapCut "limpa" algum campo específico de edições feitas por fora (como parece acontecer com a duração de transição). Esse comparativo antes/depois já foi feito uma vez neste projeto (mtime e diff de `draft_content.json`) e vale virar rotina padrão pós-fix, não uma checagem pontual.
- **Código (melhoria pequena):** o erro de `.locked` em `save()` (linha 489) já orienta a fechar o CapCut; vale também expor no retorno de `capcut_read_timeline` (`timeline()` já devolve `locked` e `capcutRunning`, linha 152) uma mensagem mais visível tipo `"⚠ CapCut está aberto neste draft — qualquer edição feita na UI a partir de agora pode não bater com o que está sendo montado via MCP"`, para reduzir a chance de o operador humano continuar mexendo no CapCut em paralelo à sessão MCP sem perceber o conflito (foi exatamente o que causou a mudança inesperada de estrutura da timeline relatada no estado atual do draft, no topo deste documento).
