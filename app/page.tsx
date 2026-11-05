// The main screen's route.
import Capri from "./components/Capri";

export default function Page() {
  return (
    <main className="home">
      <p className="hint">Clique sur Capri pour lui parler. Attrape-la et lance-la.</p>
      <Capri />
      <footer>
        Projet de fan non officiel, non commercial, sans lien avec CD PROJEKT RED. Basé sur{" "}
        <a href="https://github.com/lachydotmcg/capri-desktop">Capri</a> de Lachy, art par son artiste.
      </footer>
    </main>
  );
}
