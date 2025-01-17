import type { Signal } from "solid-js";
import {
  createResource,
  onCleanup,
  Resource,
  ResourceOptions,
  startTransition,
  useContext
} from "solid-js";
import type { ReconcileOptions } from "solid-js/store";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { isServer } from "solid-js/web";
import { useNavigate } from "../router";
import { isRedirectResponse, LocationHeader } from "../server/responses";
import { ServerContext } from "../server/ServerContext";
import { FETCH_EVENT, ServerFunctionEvent } from "../server/types";

interface RouteDataEvent extends ServerFunctionEvent {}

type RouteDataSource<S> = S | false | null | undefined | (() => S | false | null | undefined);

type RouteDataFetcher<S, T> = (source: S, event: RouteDataEvent) => T | Promise<T>;

type RouteDataOptions<T, S> = ResourceOptions<T> & {
  key?: RouteDataSource<S>;
};

const resources = new Set<(k: any) => void>();

export function createRouteData<T, S = true>(
  fetcher: RouteDataFetcher<S, T>,
  options?: RouteDataOptions<undefined, S>
): Resource<T | undefined>;
export function createRouteData<T, S = true>(
  fetcher: RouteDataFetcher<S, T>,
  options: RouteDataOptions<T, S>
): Resource<T>;
export function createRouteData<T, S>(
  fetcher?: RouteDataFetcher<S, T>,
  options: RouteDataOptions<T, S> | RouteDataOptions<undefined, S> = {}
): Resource<T> | Resource<T | undefined> {
  const navigate = useNavigate();
  const pageEvent = useContext(ServerContext);

  function handleResponse(response: Response) {
    if (isRedirectResponse(response)) {
      startTransition(() => {
        let url = response.headers.get(LocationHeader);
        if (url.startsWith("/")) {
          navigate(url, {
            replace: true
          });
        } else {
          if (!isServer) {
            window.location.href = url;
          }
        }
      });
      if (isServer) {
        pageEvent.setStatusCode(response.status);
        response.headers.forEach((head, value) => {
          pageEvent.responseHeaders.set(value, head);
        });
      }
    }
  }

  const resourceFetcher = async (key: S, info) => {
    try {
      if (info.refetching && info.refetching !== true && !partialMatch(key, info.refetching)) {
        return info.value;
      }

      let event = pageEvent as RouteDataEvent;
      if (isServer) {
        event = Object.freeze({
          request: pageEvent.request,
          env: pageEvent.env,
          $type: FETCH_EVENT,
          fetch: pageEvent.fetch
        });
      }

      let response = await (fetcher as any).call(event, key, event);
      if (response instanceof Response) {
        if (isServer) {
          handleResponse(response);
        } else {
          setTimeout(() => handleResponse(response), 0);
        }
      }
      return response;
    } catch (e) {
      if (e instanceof Response) {
        if (isServer) {
          handleResponse(e);
        } else {
          setTimeout(() => handleResponse(e), 0);
        }
        return e;
      }
      throw e;
    }
  };

  const [resource, { refetch }] = createResource<T, S>(
    (options.key || true) as RouteDataSource<S>,
    resourceFetcher,
    {
      storage: createDeepSignal,
      ...options
    }
  );

  resources.add(refetch);
  onCleanup(() => resources.delete(refetch));

  return resource;
}

export function refetchRouteData(key?: string | any[] | void) {
  for (let refetch of resources) refetch(key);
}

function createDeepSignal<T>(value: T, options?: ReconcileOptions): Signal<T> {
  const [store, setStore] = createStore({
    value
  });
  return [
    () => store.value,
    (v: T) => {
      const unwrapped = unwrap(store.value);
      typeof v === "function" && (v = v(unwrapped));
      setStore("value", reconcile(v, options));
      return store.value;
    }
  ] as Signal<T>;
}

/* React Query key matching  https://github.com/tannerlinsley/react-query */
function partialMatch(a, b) {
  return partialDeepEqual(ensureQueryKeyArray(a), ensureQueryKeyArray(b));
}

function ensureQueryKeyArray(value) {
  return Array.isArray(value) ? value : [value];
}

/**
 * Checks if `b` partially matches with `a`.
 */
function partialDeepEqual(a, b) {
  if (a === b) {
    return true;
  }

  if (typeof a !== typeof b) {
    return false;
  }

  if (a.length && !b.length) return false;

  if (a && b && typeof a === "object" && typeof b === "object") {
    return !Object.keys(b).some(key => !partialDeepEqual(a[key], b[key]));
  }

  return false;
}
