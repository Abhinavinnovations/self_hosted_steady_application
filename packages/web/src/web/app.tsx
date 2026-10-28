import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import Index from "./pages/index";
import Admin from "./pages/admin";
import { Provider } from "./components/provider";

const UiOptions = lazy(() => import("./pages/ui-options"));
const PaperStudies = lazy(() => import("./pages/paper-studies"));
const Invitation = lazy(() => import("./pages/invitation"));

function App() {
  return (
    <Provider>
      <Switch>
        <Route path="/" component={Index} />
        <Route path="/admin" component={Admin} />
        <Route path="/invitation">
          <Suspense fallback={<output>Opening invitation…</output>}><Invitation /></Suspense>
        </Route>
        <Route path="/ui-options">
          <Suspense fallback={<output>Loading welcome studies…</output>}>
            <UiOptions />
          </Suspense>
        </Route>
        <Route path="/paper-studies">
          <Suspense fallback={<output>Loading paper studies…</output>}>
            <PaperStudies />
          </Suspense>
        </Route>
      </Switch>
    </Provider>
  );
}

export default App;
