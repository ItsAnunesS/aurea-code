# Aurea Code

IDE desktop minimalista em **Rust + Tauri 2**, com interface TypeScript, CodeMirror e xterm.js. MVP para Linux x86_64 (AppImage) e Windows x86_64 (instaladores NSIS `.exe` e MSI).

## Funcionalidades

- Workspaces persistentes com múltiplos projetos locais e perfis Codex/Claude.
- Explorador, criação de ficheiros e editor com destaque de sintaxe para JS/TS, JSON e Rust, pesquisa e undo/redo. Outros ficheiros UTF-8 abrem como texto.
- Sincronização do ficheiro aberto com o disco a cada 3 segundos e ao recuperar o foco. Alterações externas são carregadas se não houver edições locais; guardar recusa conflitos detetados. Limite de 2 MiB por ficheiro.
- Terminais PTY reais para shell, Codex, Claude e `docker compose up --build`, até oito sessões. Cada terminal identifica projeto e conta.
- Git: estado, diff, staging, histórico e commits com os hooks normais do repositório.
- Docker: containers do contexto ativo, logs, iniciar, parar, reiniciar e Compose no projeto ativo.
- Menu nativo, atalhos, seleção nativa de pastas, abertura no gestor de ficheiros, instância única e bandeja do sistema.
- AppImage com fonte de atualização incorporada para Gear Lever e ficheiro `.zsync`.

## Desenvolvimento

Node 22, Rust 1.99.1 e os pré-requisitos desktop do [Tauri](https://v2.tauri.app/start/prerequisites/). No Linux, a imagem Docker inclui GTK, WebKitGTK, AppIndicator, Rust, Node e as ferramentas AppImage.

Preferencialmente, use Docker para as verificações e empacotamento:

```sh
docker compose build dev
docker compose run --rm dev npm ci
docker compose run --rm dev npm run check
docker compose run --rm dev cargo test --locked --manifest-path src-tauri/Cargo.toml
docker compose run --rm dev cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
docker compose run --rm dev cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Para testar a janela desktop real em display virtual, depois de gerar o binário release:

```sh
docker compose build ui-test
docker compose run --rm ui-test
```

O teste usa um projeto temporário e uma área de dados isolada. Verifica workspaces, perfis, guardar/sincronizar ficheiros, Git e terminal reais; a indisponibilidade de Docker também é exercitada. Guarda uma captura em `artifacts/desktop-preview.png`. Não usa contas reais dos agentes nem o socket Docker do host.

Para pré-visualizar apenas a interface: `docker compose up dev` e abrir `http://localhost:1420`. O browser identifica explicitamente este modo e não simula acesso a ficheiros, Git, Docker ou agentes.

Para executar a aplicação desktop no computador, com acesso ao ambiente gráfico e às ferramentas locais:

```sh
npm ci
npm run tauri -- dev
```

Os volumes Docker isolam `node_modules` e o target Rust do host. Não se monta o socket Docker do host no container de desenvolvimento. A aplicação instalada usa o Docker CLI do utilizador; compilar em Docker não concede controlo dos containers do host.

## Primeira utilização

1. Crie um workspace ou use **Pessoal**.
2. Use **Adicionar projeto** e selecione uma pasta existente (também pode criar uma pasta pelo diálogo do sistema).
3. Em **Contas de IA**, crie um perfil Codex ou Claude para cada conta. Pode associar o mesmo perfil a vários workspaces.
4. Abra um projeto, escolha o perfil e clique **Iniciar agente**. Faça o login dentro do CLI oficial. A Aurea não fornece nem contorna subscrições dos fornecedores.
5. Instale `git`, `docker`, `codex` e/ou `claude` como executáveis nativos acessíveis no `PATH`. **Ambiente** mostra os caminhos encontrados. No Windows, esta versão requer `.exe`, não wrappers `.cmd` de npm. Reinicie a IDE após instalar ferramentas.

O Codex recebe um `CODEX_HOME` por perfil; o Claude recebe um `CLAUDE_CONFIG_DIR` por perfil. As variáveis de autenticação mais comuns herdadas do processo pai são removidas das sessões dos agentes, evitando que uma chave API substitua silenciosamente a conta escolhida. Login, tokens, aprovação de ferramentas e histórico são geridos pelos CLIs oficiais. A mudança de perfil abre uma nova sessão e não altera terminais existentes.

Os metadados ficam no diretório de dados do Tauri (`dev.aurea.code`); `workspace.json` não guarda tokens. Os diretórios dos perfis usam permissões `0700` em Unix; no Windows aplica-se a proteção do diretório de dados do utilizador. Os perfis são uma separação de configuração, não uma sandbox entre contas. Políticas empresariais, credential helpers e configurações do próprio CLI continuam a aplicar-se.

Fechar a janela mantém a aplicação na bandeja quando esta está disponível. Para encerrar, use **Ficheiro → Sair** ou o menu da bandeja. Terminais ativos e edições por guardar exigem confirmação. Em GNOME, pode ser necessária uma extensão AppIndicator para ver a bandeja; abrir novamente o executável restaura a janela existente.

## Builds e Gear Lever

### Linux AppImage

```sh
docker compose run --rm dev bash scripts/build-appimage.sh
```

O resultado fica em `artifacts/`:

- `Aurea-Code-<versão>-x86_64.AppImage`
- `Aurea-Code-<versão>-x86_64.AppImage.zsync`
- `SHA256SUMS-linux.txt`

O build usa Debian 12 (glibc 2.36). Valide a distribuição de destino; não se promete compatibilidade com distribuições mais antigas. O primeiro build descarrega as ferramentas de empacotamento usadas pelo Tauri.

A informação incorporada no AppImage é:

```text
gh-releases-zsync|ItsAnunesS|aurea-code|latest|Aurea-Code-*-x86_64.AppImage.zsync
```

O script falha se essa informação estiver ausente ou se o nome, tamanho e URL do `.zsync` não corresponderem ao AppImage. O `.zsync` aponta para a versão imutável `releases/download/v<versão>/...`.

Abra o AppImage no Gear Lever e integre-o. A origem GitHub será detetada pelos metadados; ative a pesquisa automática de atualizações nas preferências do Gear Lever. A frequência de pesquisa, notificações e aplicação das atualizações pertencem ao Gear Lever. O AppImage não altera essas preferências nem instala o Gear Lever. A primeira release pública tem de existir para a pesquisa funcionar.

### Windows

Execute num host/runner Windows com os pré-requisitos Tauri:

```powershell
npm ci
npm run tauri -- build --bundles nsis,msi --ci -- --locked
```

Os instaladores ficam em `src-tauri/target/release/bundle/`. Não estão configurados certificados de assinatura de código. O Windows pode apresentar avisos de editor desconhecido. Atualizações Windows são instaladas manualmente nesta versão.

### Publicação no GitHub

O workflow `.github/workflows/build.yml` testa e compila Linux e Windows. A branch principal é `release`. Em pushes para `release` e pull requests, disponibiliza artefactos sem publicar. Um push de uma tag `v<versão>` publica uma release estável **apenas depois de ambos os builds e testes passarem**, com AppImage, `.zsync` e instaladores Windows juntos.

Antes da tag, mantenha a versão igual em `package.json`, `src-tauri/Cargo.toml` e `src-tauri/tauri.conf.json`, atualize os lockfiles e execute as verificações. `node scripts/check-version.mjs` valida a consistência. Não reutilize tags ou substitua ficheiros de uma versão já publicada. A fonte de atualizações está fixada em `ItsAnunesS/aurea-code`; forks devem alterá-la no script e no verificador.

## Limites deste MVP

- A integração com Codex/Claude usa os CLIs interativos reais. Não replica automaticamente o histórico das aplicações web/desktop nem inclui chat gráfico via app-server/Agent SDK.
- Não inclui LSP/autocomplete semântico, debugger, extensões VS Code, colaboração online, gestão de branches/remotos ou resolução gráfica de conflitos Git. Operações avançadas podem ser feitas no terminal.
- O explorador omite `.git`, `node_modules`, `target` e links simbólicos. Não edita binários. A sincronização acompanha o ficheiro aberto; use atualizar para recarregar a árvore.
- Git e Docker usam argumentos separados, sem interpolar comandos num shell; os comandos da interface são limitados às operações implementadas. Os terminais permitem execução interativa normal e os processos mantêm as permissões do utilizador. Não abra projetos não confiáveis: configurações, hooks, agentes e Compose podem executar código.
- Encerrar um terminal interrompe o processo principal; serviços Docker e processos deliberadamente destacados podem continuar ativos. A verificação de conflito ao guardar não é um bloqueio distribuído contra escritores externos simultâneos.
- Valide login e alternância de contas com as versões dos CLIs e as políticas de credenciais do seu sistema. A aplicação não lê nem apresenta tokens.

Referências: [Tauri](https://v2.tauri.app/), [Codex — diretórios de estado](https://learn.chatgpt.com/docs/config-file/environment-variables), [Claude — configuração](https://code.claude.com/docs/en/settings), [AppImage — atualizações](https://docs.appimage.org/packaging-guide/optional/updates.html), [Gear Lever](https://github.com/mijorus/gearlever).
