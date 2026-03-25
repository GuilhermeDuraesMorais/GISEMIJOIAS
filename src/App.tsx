import React, { useState, useEffect, useMemo } from 'react';
import { 
  Plus, 
  Trash2, 
  Search, 
  TrendingDown, 
  History, 
  Cpu, 
  LogOut, 
  LogIn, 
  ChevronRight, 
  Package, 
  CheckCircle2, 
  AlertCircle,
  Loader2,
  FileText,
  Filter
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { 
  collection, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  query, 
  orderBy, 
  setDoc,
  writeBatch,
  getDocs
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import { GoogleGenAI, Type } from "@google/genai";
import { db, auth, signIn, logout } from './firebase';
import { Product, Sale, RawInput, OperationType, FirestoreErrorInfo } from './types';

// --- Error Handling ---
function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- App Component ---
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState<'inventory' | 'sales' | 'ai' | 'history'>('inventory');
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [rawInputs, setRawInputs] = useState<RawInput[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [materialFilter, setMaterialFilter] = useState<string>('Todos');
  const [isProcessingAI, setIsProcessingAI] = useState(false);
  const [aiInput, setAiInput] = useState('');
  const [aiPreviewData, setAiPreviewData] = useState<Product[] | null>(null);
  const [replaceInventory, setReplaceInventory] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // --- Auth Listener ---
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
  }, []);

  // --- Firestore Listeners ---
  useEffect(() => {
    if (!user || !isAuthReady) return;

    const unsubInventory = onSnapshot(collection(db, 'inventory'), (snapshot) => {
      setProducts(snapshot.docs.map(doc => ({ ...doc.data() } as Product)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'inventory'));

    const unsubSales = onSnapshot(query(collection(db, 'sales_history'), orderBy('date', 'desc')), (snapshot) => {
      setSales(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Sale)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'sales_history'));

    const unsubRaw = onSnapshot(query(collection(db, 'raw_inputs'), orderBy('uploadDate', 'desc')), (snapshot) => {
      setRawInputs(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as RawInput)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'raw_inputs'));

    return () => {
      unsubInventory();
      unsubSales();
      unsubRaw();
    };
  }, [user, isAuthReady]);

  // --- AI Processing ---
  const handleAIPreview = async () => {
    if (!aiInput.trim()) return;
    setIsProcessingAI(true);
    setError(null);
    setAiPreviewData(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: aiInput,
        config: {
          systemInstruction: `Você é um especialista em inventário de semijoias. 
          Receba uma lista de semijoias, ignore a linha 'TOTAL GERAL'.
          Identifique o Código (id), Categoria, Quantidade (initialQuantity) e Valor (unitValue).
          Extraia se o material é Ouro, Prata ou Ródio do nome da categoria ou do contexto.
          Retorne obrigatoriamente um JSON estruturado como um ARRAY de objetos com as chaves: id, category, material, initialQuantity, currentQuantity, unitValue.
          currentQuantity deve ser igual a initialQuantity inicialmente.`,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                category: { type: Type.STRING },
                material: { type: Type.STRING },
                initialQuantity: { type: Type.NUMBER },
                currentQuantity: { type: Type.NUMBER },
                unitValue: { type: Type.NUMBER }
              },
              required: ["id", "category", "material", "initialQuantity", "currentQuantity", "unitValue"]
            }
          }
        }
      });

      const parsedData = JSON.parse(response.text);
      setAiPreviewData(parsedData);
    } catch (err) {
      console.error(err);
      setError("Erro ao processar com IA. Verifique o formato do texto.");
    } finally {
      setIsProcessingAI(false);
    }
  };

  const commitAICatalog = async () => {
    if (!aiPreviewData) return;
    setIsProcessingAI(true);

    try {
      const batch = writeBatch(db);
      
      // Save raw input record
      await addDoc(collection(db, 'raw_inputs'), {
        originalText: aiInput,
        status: 'processed',
        uploadDate: new Date().toISOString()
      });

      if (replaceInventory) {
        // Clear existing inventory
        const existingDocs = await getDocs(collection(db, 'inventory'));
        existingDocs.forEach(d => batch.delete(d.ref));
      }

      // Add new products
      aiPreviewData.forEach((p: Product) => {
        const docRef = doc(db, 'inventory', p.id);
        batch.set(docRef, p);
      });

      await batch.commit();
      setAiInput('');
      setAiPreviewData(null);
      setActiveTab('inventory');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'inventory');
    } finally {
      setIsProcessingAI(false);
    }
  };

  // --- Sale Action ---
  const handleSale = async (product: Product) => {
    if (product.currentQuantity <= 0) {
      alert("Estoque esgotado!");
      return;
    }

    try {
      const batch = writeBatch(db);
      
      // Decrease quantity
      const productRef = doc(db, 'inventory', product.id);
      batch.update(productRef, {
        currentQuantity: product.currentQuantity - 1
      });

      // Add to history
      const saleRef = doc(collection(db, 'sales_history'));
      batch.set(saleRef, {
        date: new Date().toISOString(),
        productId: product.id,
        category: product.category,
        saleValue: product.unitValue
      });

      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, 'inventory');
    }
  };

  // --- Filtering ---
  const filteredProducts = useMemo(() => {
    return products.filter(p => {
      const matchesSearch = p.id.toLowerCase().includes(searchTerm.toLowerCase()) || 
                            p.category.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesMaterial = materialFilter === 'Todos' || p.material === materialFilter;
      return matchesSearch && matchesMaterial;
    });
  }, [products, searchTerm, materialFilter]);

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-neutral-100 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-neutral-400" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-neutral-100 flex flex-col items-center justify-center p-6 text-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full"
        >
          <div className="w-16 h-16 bg-neutral-900 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Package className="text-white w-8 h-8" />
          </div>
          <h1 className="text-3xl font-bold text-neutral-900 mb-2">GI Semijoias</h1>
          <p className="text-neutral-500 mb-8">Controle de estoque inteligente e simplificado.</p>
          <button 
            onClick={signIn}
            className="w-full bg-neutral-900 text-white py-4 rounded-2xl font-semibold flex items-center justify-center gap-3 hover:bg-neutral-800 transition-colors"
          >
            <LogIn className="w-5 h-5" />
            Entrar com Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 font-sans pb-24">
      {/* Header */}
      <header className="bg-white border-b border-neutral-200 px-6 py-4 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-neutral-900 rounded-xl flex items-center justify-center">
              <Package className="text-white w-5 h-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">GI Semijoias</h1>
          </div>
          <button 
            onClick={logout}
            className="p-2 text-neutral-400 hover:text-neutral-900 transition-colors"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        {/* Tabs */}
        <div className="flex gap-2 mb-8 overflow-x-auto pb-2 scrollbar-hide">
          {[
            { id: 'inventory', label: 'Estoque', icon: Package },
            { id: 'ai', label: 'Processar IA', icon: Cpu },
            { id: 'history', label: 'Histórico', icon: History },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-6 py-3 rounded-2xl font-medium transition-all whitespace-nowrap ${
                activeTab === tab.id 
                ? 'bg-neutral-900 text-white shadow-lg shadow-neutral-200' 
                : 'bg-white text-neutral-500 hover:bg-neutral-100'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {activeTab === 'inventory' && (
            <motion.div
              key="inventory"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="space-y-6"
            >
              {/* Summary Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'Total Itens', value: products.length, icon: Package },
                  { label: 'Estoque Total', value: products.reduce((acc, p) => acc + p.currentQuantity, 0), icon: Filter },
                  { label: 'Valor Total', value: products.reduce((acc, p) => acc + (p.currentQuantity * p.unitValue), 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }), icon: TrendingDown },
                  { label: 'Vendas Hoje', value: sales.filter(s => format(new Date(s.date), 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd')).length, icon: History },
                ].map((stat, i) => (
                  <div key={i} className="bg-white p-4 rounded-2xl border border-neutral-200 shadow-sm">
                    <p className="text-[10px] uppercase tracking-widest text-neutral-400 font-bold mb-1">{stat.label}</p>
                    <p className="text-xl font-black text-neutral-900">{stat.value}</p>
                  </div>
                ))}
              </div>

              {/* Filters */}
              <div className="flex flex-col md:flex-row gap-4">
                <div className="relative flex-1">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-400 w-5 h-5" />
                  <input 
                    type="text"
                    placeholder="Buscar por código ou categoria..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-12 pr-4 py-4 bg-white border border-neutral-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-neutral-900/10"
                  />
                </div>
                <div className="flex gap-2">
                  {['Todos', 'Ouro', 'Prata', 'Ródio'].map(m => (
                    <button
                      key={m}
                      onClick={() => setMaterialFilter(m)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                        materialFilter === m 
                        ? 'bg-neutral-900 text-white' 
                        : 'bg-white border border-neutral-200 text-neutral-500'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              {/* Product Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredProducts.map((p) => (
                  <motion.div 
                    layout
                    key={p.id}
                    className="bg-white p-6 rounded-3xl border border-neutral-200 shadow-sm hover:shadow-md transition-shadow"
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <span className="text-xs font-bold text-neutral-400 uppercase tracking-widest">{p.id}</span>
                        <h3 className="text-lg font-bold text-neutral-900">{p.category}</h3>
                        <span className={`inline-block px-2 py-1 rounded-lg text-[10px] font-bold uppercase mt-1 ${
                          p.material === 'Ouro' ? 'bg-amber-100 text-amber-700' :
                          p.material === 'Prata' ? 'bg-slate-100 text-slate-700' :
                          'bg-indigo-100 text-indigo-700'
                        }`}>
                          {p.material}
                        </span>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-neutral-400">Preço</p>
                        <p className="text-lg font-bold text-neutral-900">
                          {p.unitValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between mt-6 pt-6 border-t border-neutral-100">
                      <div className="flex flex-col">
                        <span className="text-xs text-neutral-400 uppercase font-bold tracking-tighter">Estoque</span>
                        <span className={`text-2xl font-black ${p.currentQuantity === 0 ? 'text-red-500' : 'text-neutral-900'}`}>
                          {p.currentQuantity}
                        </span>
                      </div>
                      <button 
                        onClick={() => handleSale(p)}
                        disabled={p.currentQuantity === 0}
                        className="bg-neutral-900 text-white px-6 py-3 rounded-2xl font-bold flex items-center gap-2 hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                      >
                        <TrendingDown className="w-4 h-4" />
                        Vender
                      </button>
                    </div>
                  </motion.div>
                ))}
              </div>
              
              {filteredProducts.length === 0 && (
                <div className="text-center py-20 bg-white rounded-3xl border border-dashed border-neutral-200">
                  <Package className="w-12 h-12 text-neutral-200 mx-auto mb-4" />
                  <p className="text-neutral-400">Nenhum produto encontrado.</p>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'ai' && (
            <motion.div
              key="ai"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="max-w-4xl mx-auto space-y-6"
            >
              {!aiPreviewData ? (
                <div className="bg-white p-8 rounded-3xl border border-neutral-200 shadow-sm">
                  <div className="flex items-center gap-3 mb-6">
                    <Cpu className="w-6 h-6 text-neutral-900" />
                    <h2 className="text-2xl font-bold">Importar Catálogo</h2>
                  </div>
                  <p className="text-neutral-500 mb-6 text-sm leading-relaxed">
                    Cole o texto bruto do seu catálogo ou lista de peças. A IA identificará automaticamente códigos, categorias, materiais e valores.
                  </p>
                  
                  <textarea 
                    value={aiInput}
                    onChange={(e) => setAiInput(e.target.value)}
                    placeholder="Ex: ACESSORIOS 24691 47 47,00..."
                    className="w-full h-64 p-6 bg-neutral-50 border border-neutral-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-neutral-900/10 font-mono text-sm mb-6 resize-none"
                  />

                  {error && (
                    <div className="flex items-center gap-2 p-4 bg-red-50 text-red-600 rounded-xl mb-6 text-sm">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      {error}
                    </div>
                  )}

                  <button 
                    onClick={handleAIPreview}
                    disabled={isProcessingAI || !aiInput.trim()}
                    className="w-full bg-neutral-900 text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-neutral-800 disabled:opacity-50 transition-all"
                  >
                    {isProcessingAI ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Analisando dados...
                      </>
                    ) : (
                      <>
                        <Search className="w-5 h-5" />
                        Analisar Catálogo
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="bg-white p-8 rounded-3xl border border-neutral-200 shadow-sm">
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-3">
                        <CheckCircle2 className="w-6 h-6 text-green-500" />
                        <h2 className="text-2xl font-bold">Confirmação de Dados</h2>
                      </div>
                      <button 
                        onClick={() => setAiPreviewData(null)}
                        className="text-sm text-neutral-400 hover:text-neutral-900"
                      >
                        Voltar e Editar
                      </button>
                    </div>

                    <div className="bg-neutral-50 p-6 rounded-2xl mb-8">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-neutral-400 mb-4">Opções de Importação</h3>
                      <div className="flex gap-4">
                        <button 
                          onClick={() => setReplaceInventory(true)}
                          className={`flex-1 p-4 rounded-xl border-2 transition-all text-left ${
                            replaceInventory 
                            ? 'border-neutral-900 bg-neutral-900 text-white' 
                            : 'border-neutral-200 bg-white text-neutral-500'
                          }`}
                        >
                          <p className="font-bold">Substituir Tudo</p>
                          <p className="text-xs opacity-70">Apaga o estoque atual e define este como o novo.</p>
                        </button>
                        <button 
                          onClick={() => setReplaceInventory(false)}
                          className={`flex-1 p-4 rounded-xl border-2 transition-all text-left ${
                            !replaceInventory 
                            ? 'border-neutral-900 bg-neutral-900 text-white' 
                            : 'border-neutral-200 bg-white text-neutral-500'
                          }`}
                        >
                          <p className="font-bold">Adicionar Itens</p>
                          <p className="text-xs opacity-70">Mantém o estoque atual e adiciona estes novos itens.</p>
                        </button>
                      </div>
                    </div>

                    <div className="overflow-x-auto border border-neutral-100 rounded-2xl">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-neutral-50 text-neutral-400 font-bold uppercase text-[10px]">
                          <tr>
                            <th className="px-4 py-3">Código</th>
                            <th className="px-4 py-3">Categoria</th>
                            <th className="px-4 py-3">Material</th>
                            <th className="px-4 py-3 text-right">Qtd</th>
                            <th className="px-4 py-3 text-right">Valor</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-neutral-100">
                          {aiPreviewData.map((p, i) => (
                            <tr key={i}>
                              <td className="px-4 py-3 font-mono font-bold">{p.id}</td>
                              <td className="px-4 py-3">{p.category}</td>
                              <td className="px-4 py-3">{p.material}</td>
                              <td className="px-4 py-3 text-right">{p.initialQuantity}</td>
                              <td className="px-4 py-3 text-right font-bold">{p.unitValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <button 
                      onClick={commitAICatalog}
                      disabled={isProcessingAI}
                      className="w-full mt-8 bg-green-600 text-white py-4 rounded-2xl font-bold flex items-center justify-center gap-3 hover:bg-green-700 transition-all"
                    >
                      {isProcessingAI ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-5 h-5" />
                      )}
                      Confirmar e Salvar no Banco
                    </button>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'history' && (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-2xl font-bold">Vendas e Arquivos</h2>
                <button 
                  onClick={async () => {
                    if (products.length === 0) return;
                    const month = format(new Date(), 'yyyy-MM');
                    try {
                      await addDoc(collection(db, 'monthly_archives'), {
                        referenceMonth: month,
                        closingData: JSON.stringify(products)
                      });
                      alert(`Mês ${month} arquivado com sucesso!`);
                    } catch (err) {
                      handleFirestoreError(err, OperationType.CREATE, 'monthly_archives');
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-white border border-neutral-200 rounded-xl text-sm font-bold hover:bg-neutral-50 transition-colors"
                >
                  <FileText className="w-4 h-4" />
                  Arquivar Mês Atual
                </button>
              </div>

              <div className="bg-white rounded-3xl border border-neutral-200 overflow-hidden shadow-sm">
                <div className="p-6 border-b border-neutral-100 flex items-center justify-between">
                  <h2 className="text-xl font-bold">Histórico de Vendas</h2>
                  <History className="w-5 h-5 text-neutral-400" />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="bg-neutral-50 text-neutral-400 text-[10px] font-bold uppercase tracking-widest">
                        <th className="px-6 py-4">Data</th>
                        <th className="px-6 py-4">Código</th>
                        <th className="px-6 py-4">Categoria</th>
                        <th className="px-6 py-4 text-right">Valor</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {sales.map((sale) => (
                        <tr key={sale.id} className="hover:bg-neutral-50 transition-colors">
                          <td className="px-6 py-4 text-sm text-neutral-500">
                            {format(new Date(sale.date), "dd/MM/yy HH:mm", { locale: ptBR })}
                          </td>
                          <td className="px-6 py-4 font-mono text-sm font-bold">{sale.productId}</td>
                          <td className="px-6 py-4 text-sm">{sale.category}</td>
                          <td className="px-6 py-4 text-right font-bold">
                            {sale.saleValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {sales.length === 0 && (
                  <div className="p-12 text-center text-neutral-400">
                    Nenhuma venda registrada ainda.
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Mobile Nav Overlay (Optional if tabs are enough) */}
    </div>
  );
}
